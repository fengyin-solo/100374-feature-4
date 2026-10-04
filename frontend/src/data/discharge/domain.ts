/**
 * 流量签认链路的纯领域逻辑：不碰 localStorage，不碰 Vue。
 * 所有流转都走「校验 → 不可变更新」，校验失败直接抛错，调用方不得写库，
 * 因此失败时绝不会留下半份签认。
 */

import type {
  DischargeRecord,
  SealEvent,
  SignoffStage,
  SignoffVersion,
} from './types'

export class DomainError extends Error {}

// 状态机：只允许沿签认链路顺序流转，不允许跳段、不允许回退到已签认之前。
const ALLOWED_NEXT: Record<SignoffStage, SignoffStage[]> = {
  草稿: ['已锁定', '异常值'],
  已锁定: ['已签认', '退回修订'],
  已签认: ['异常值'],
  退回修订: ['已锁定', '异常值'],
  异常值: ['草稿'],
}

export function canTransit(from: SignoffStage, to: SignoffStage): boolean {
  return ALLOWED_NEXT[from].includes(to)
}

export function isTerminal(stage: SignoffStage): boolean {
  return stage === '已签认' || stage === '异常值'
}

export function nowStamp(): string {
  return new Date().toISOString()
}

export function makeEvent(
  type: SealEvent['type'],
  operator: string,
  note?: string,
): SealEvent {
  return { type, operator, at: nowStamp(), ...(note ? { note } : {}) }
}

function assertRev(record: DischargeRecord, expectedRev: number): void {
  if (record.rev !== expectedRev) {
    throw new DomainError(
      `记录 ${record.记录编号} 已被他人改动（版本 ${expectedRev} → ${record.rev}），请刷新后重试`,
    )
  }
}

function assertStage(record: DischargeRecord, allowed: SignoffStage[]): void {
  if (!allowed.includes(record.stage)) {
    throw new DomainError(
      `记录 ${record.记录编号} 当前为「${record.stage}」，不能执行该签认操作`,
    )
  }
}

function assertComplete(record: DischargeRecord): void {
  const pairs: [keyof DischargeRecord['draft'], string][] = [
    ['测量方法', '测量方法'],
    ['断面流量', '断面流量'],
    ['最大流速', '最大流速'],
    ['过水面积', '过水面积'],
    ['测量时间', '测量时间'],
  ]
  for (const [key, label] of pairs) {
    if (String(record.draft[key] ?? '').trim() === '') {
      throw new DomainError(`${label}未填写完整，不能锁定原始读数`)
    }
  }
}

/** 取最近一次锁定的版本（用于过水面积跟随沿用）。 */
export function latestLockedVersion(
  record: DischargeRecord,
): SignoffVersion | null {
  for (let i = record.versions.length - 1; i >= 0; i -= 1) {
    return record.versions[i]
  }
  return null
}

/** 取已签认版本（最近一轮通过的成果）；没有则返回 null。 */
export function signedVersion(record: DischargeRecord): SignoffVersion | null {
  for (let i = record.versions.length - 1; i >= 0; i -= 1) {
    if (record.versions[i].status === '已签认') {
      return record.versions[i]
    }
  }
  return null
}

/**
 * 测量员锁定原始读数：草稿/退回修订 → 已锁定。
 * 决定：过水面积是断面几何量，测量方法变更时旧过水面积跟随沿用，
 * 不让前端传进来的面积覆盖最近锁定值；每轮版本仍固化自己的面积快照。
 */
export function lockReadings(input: {
  record: DischargeRecord
  expectedRev: number
  surveyor: string
  draft: DischargeRecord['draft']
}): DischargeRecord {
  const { record, expectedRev, surveyor, draft } = input
  assertRev(record, expectedRev)
  assertStage(record, ['草稿', '退回修订'])

  // 旧过水面积跟随沿用：有历史锁定版本时，面积一律取上一轮快照。
  const previous = latestLockedVersion(record)
  const nextDraft = { ...draft }
  if (previous) {
    nextDraft.过水面积 = previous.readings.过水面积
  }

  const candidate: DischargeRecord = {
    ...record,
    draft: nextDraft,
  }
  assertComplete(candidate)

  const versionNo = record.versions.length + 1
  const event = makeEvent('锁定', surveyor)
  const version: SignoffVersion = {
    version: versionNo,
    readings: { ...nextDraft },
    lockedBy: surveyor,
    lockedAt: event.at,
    status: '已锁定',
    events: [event],
  }

  return {
    ...candidate,
    stage: '已锁定',
    rev: record.rev + 1,
    currentVersion: versionNo,
    versions: [...record.versions, version],
    timeline: [...record.timeline, event],
    updatedAt: event.at,
  }
}

/** 审核员签认：已锁定 → 已签认。两名审核员并发时只有一个 CAS 能成功落章。 */
export function signRecord(input: {
  record: DischargeRecord
  expectedRev: number
  reviewer: string
  note?: string
}): DischargeRecord {
  const { record, expectedRev, reviewer, note } = input
  assertRev(record, expectedRev)
  assertStage(record, ['已锁定'])
  if (record.currentVersion === null) {
    throw new DomainError(`记录 ${record.记录编号} 缺少待签认版本`)
  }

  const event = makeEvent('签认', reviewer, note)
  const versionNo = record.currentVersion
  const versions = record.versions.map((item) =>
    item.version === versionNo
      ? { ...item, status: '已签认' as const, events: [...item.events, event] }
      : item,
  )

  return {
    ...record,
    stage: '已签认',
    rev: record.rev + 1,
    versions,
    timeline: [...record.timeline, event],
    updatedAt: event.at,
  }
}

/** 审核员退回：已锁定 → 退回修订。退回到测量员，再锁定生成新版本，老版本保留为已退回。 */
export function returnRecord(input: {
  record: DischargeRecord
  expectedRev: number
  reviewer: string
  reason?: string
}): DischargeRecord {
  const { record, expectedRev, reviewer, reason } = input
  assertRev(record, expectedRev)
  assertStage(record, ['已锁定'])
  if (record.currentVersion === null) {
    throw new DomainError(`记录 ${record.记录编号} 缺少待签认版本`)
  }

  const event = makeEvent('退回', reviewer, reason)
  const versionNo = record.currentVersion
  const versions = record.versions.map((item) =>
    item.version === versionNo
      ? { ...item, status: '已退回' as const, events: [...item.events, event] }
      : item,
  )

  return {
    ...record,
    stage: '退回修订',
    rev: record.rev + 1,
    currentVersion: null,
    versions,
    timeline: [...record.timeline, event],
    updatedAt: event.at,
  }
}

/** 测量员标记异常：只在测量员可编辑阶段操作，标记为异常值终态。 */
export function markAbnormal(input: {
  record: DischargeRecord
  expectedRev: number
  surveyor: string
  reason?: string
}): DischargeRecord {
  const { record, expectedRev, surveyor, reason } = input
  assertRev(record, expectedRev)
  assertStage(record, ['草稿', '退回修订'])

  const event = makeEvent('标记异常', surveyor, reason)
  return {
    ...record,
    stage: '异常值',
    rev: record.rev + 1,
    timeline: [...record.timeline, event],
    updatedAt: event.at,
  }
}

/**
 * 整编页「退回重核」：已签认 → 退回修订，重开一轮测量修订。
 * 历史签认版本原样保留（兼容历史成果），新一轮需重新锁定、重新签认。
 */
export function reopenFromCompilation(input: {
  record: DischargeRecord
  expectedRev: number
  reviewer: string
  reason?: string
}): DischargeRecord {
  const { record, expectedRev, reviewer, reason } = input
  assertRev(record, expectedRev)
  assertStage(record, ['已签认'])

  const event = makeEvent('整编退回', reviewer, reason)
  return {
    ...record,
    stage: '退回修订',
    rev: record.rev + 1,
    currentVersion: null,
    timeline: [...record.timeline, event],
    updatedAt: event.at,
  }
}

/** 旧过水面积（通用 EntryRow 时代的扁平数据）迁移成逐段签认记录。 */
export function migrateLegacyRow(row: {
  id: number
  status: string
  [field: string]: string | number | boolean
}): DischargeRecord {
  const readings = {
    测量方法: String(row['测量方法'] ?? ''),
    断面流量: String(row['断面流量'] ?? ''),
    最大流速: String(row['最大流速'] ?? ''),
    过水面积: String(row['过水面积'] ?? ''),
    测量时间: String(row['测量时间'] ?? ''),
  }
  const stamp = nowStamp()
  const base: DischargeRecord = {
    id: Number(row.id),
    记录编号: String(row['记录编号'] ?? `DISC-${Number(row.id)}`),
    站点编号: String(row['站点编号'] ?? ''),
    stage: '草稿',
    rev: 0,
    draft: readings,
    currentVersion: null,
    versions: [],
    timeline: [],
    updatedAt: stamp,
  }

  if (row.status === '已通过') {
    const lockEvent: SealEvent = {
      type: '锁定',
      operator: '历史测量员',
      at: stamp,
      note: '旧版记录迁移补录',
    }
    const signEvent: SealEvent = {
      type: '签认',
      operator: '历史审核员',
      at: stamp,
      note: '旧版记录迁移补录',
    }
    return {
      ...base,
      stage: '已签认',
      rev: 2,
      currentVersion: 1,
      versions: [
        {
          version: 1,
          readings: { ...readings },
          lockedBy: lockEvent.operator,
          lockedAt: lockEvent.at,
          status: '已签认',
          events: [lockEvent, signEvent],
        },
      ],
      timeline: [lockEvent, signEvent],
    }
  }

  if (row.status === '待审核') {
    const event = makeEvent('锁定', '历史测量员', '旧版记录迁移补录')
    return {
      ...base,
      stage: '已锁定',
      rev: 1,
      currentVersion: 1,
      versions: [
        {
          version: 1,
          readings: { ...readings },
          lockedBy: event.operator,
          lockedAt: event.at,
          status: '已锁定',
          events: [event],
        },
      ],
      timeline: [event],
    }
  }

  if (row.status === '异常值') {
    return { ...base, stage: '异常值', rev: 1 }
  }

  return base
}
