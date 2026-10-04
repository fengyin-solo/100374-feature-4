import { listRows, saveRows } from '@/data/local-store'
import { loadSignoffs, saveSignoffs } from '@/data/signoff-store'
import type {
  ActionResult,
  EntryRow,
  PendingCheckEntry,
  RecordSignoff,
  SegmentStatus,
  SignoffSegment,
} from '@/data/types'

// 流量监测逐段签认链路：测量员先锁定原始读数，审核员再签认或退回。
// 页面不做业务判断，所有流转、并发与幂等规则都收在这里。

const DISCHARGE_KEY = 'discharge'

export const DISCHARGE_METHODS = ['流速仪法', '声学多普勒法', '浮标法', '缆道积宽法']

/** 顺序流转表：只允许相邻状态跳转，已签认为终态。 */
const NEXT_STATUS: Record<SegmentStatus, SegmentStatus[]> = {
  待锁定: ['已锁定'],
  已锁定: ['已签认', '已退回'],
  已退回: ['已锁定'],
  已签认: [],
}

export type SignoffRequest = {
  recordId: number
  segmentId: string
  actor: string
  /** 幂等键：同一次操作连续提交时保持不变，只认首次结果。 */
  requestId: string
  /** 打开面板时读到的测段版本：并发签认时先到者生效，后到者版本对不上被拒绝。 */
  expectedVersion: number
  reason?: string
  reading?: string
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function isSurveyor(actor: string): boolean {
  return actor.startsWith('测量员')
}

export function isReviewer(actor: string): boolean {
  return actor.startsWith('审核员')
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function findRecord(
  state: Record<string, RecordSignoff>,
  recordId: number,
): { record: RecordSignoff; key: string } | null {
  const key = String(recordId)
  const record = state[key]
  return record ? { record, key } : null
}

function findSegment(record: RecordSignoff, segmentId: string): SignoffSegment | null {
  return record.segments.find((item) => item.id === segmentId) ?? null
}

function dischargeRow(recordId: number): EntryRow | null {
  return listRows(DISCHARGE_KEY).find((row) => Number(row.id) === recordId) ?? null
}

/** 记录被标记异常后签认链路暂停，先把异常处理掉。 */
function chainBlocked(recordId: number): string | null {
  const row = dischargeRow(recordId)
  if (!row) {
    return `没有找到编号为 ${recordId} 的流量记录`
  }
  if (String(row.status) === '异常值') {
    return '该流量记录已标记异常，签认链路暂停'
  }
  return null
}

/** 记录级状态由测段推导：全部待锁定→已采集，全部已签认→已通过，其余→待审核。 */
export function deriveRecordStatus(segments: SignoffSegment[]): string {
  if (segments.every((item) => item.status === '已签认')) {
    return '已通过'
  }
  if (segments.every((item) => item.status === '待锁定')) {
    return '已采集'
  }
  return '待审核'
}

/**
 * 先写签认状态再同步记录行；任何一步失败都回滚到操作前，
 * 保证失败不会留下半份签认。所有校验都在写库之前完成。
 */
function persist(
  nextState: Record<string, RecordSignoff>,
  prevState: Record<string, RecordSignoff>,
  recordId: number,
  rowPatch: Partial<EntryRow> | null,
): ActionResult | null {
  saveSignoffs(nextState)
  if (!rowPatch) {
    return null
  }
  try {
    const rows = listRows(DISCHARGE_KEY)
    const index = rows.findIndex((row) => Number(row.id) === recordId)
    if (index < 0) {
      throw new Error(`没有找到编号为 ${recordId} 的流量记录`)
    }
    const next = [...rows]
    const merged: EntryRow = { ...rows[index] }
    for (const [field, value] of Object.entries(rowPatch)) {
      if (value !== undefined) {
        merged[field] = value
      }
    }
    next[index] = merged
    saveRows(DISCHARGE_KEY, next)
    return null
  } catch (error) {
    saveSignoffs(prevState)
    return fail(
      `签认保存失败已回滚，未留下部分签认：${error instanceof Error ? error.message : '未知错误'}`,
    )
  }
}

/** 测段级流转的公共骨架：幂等重放 → 角色/状态/版本校验 → 组装完整新状态 → 原子落库。 */
function transitionSegment(
  request: SignoffRequest,
  target: SegmentStatus,
  build: (segment: SignoffSegment, record: RecordSignoff) => SignoffSegment,
  historyOf: (segment: SignoffSegment, record: RecordSignoff) => RecordSignoff['history'],
): ActionResult {
  const state = loadSignoffs()
  const found = findRecord(state, request.recordId)
  if (!found) {
    return fail('没有找到该流量记录的签认链路')
  }
  const { record, key } = found
  const segment = findSegment(record, request.segmentId)
  if (!segment) {
    return fail(`没有找到测段 ${request.segmentId}`)
  }
  if (segment.lastRequest?.requestId === request.requestId) {
    return { ok: true, message: `${segment.lastRequest.message}（重复提交，按首次结果处理）` }
  }
  if (!NEXT_STATUS[segment.status].includes(target)) {
    return fail(`测段「${segment.name}」当前为「${segment.status}」，不能流转为「${target}」`)
  }
  if (segment.version !== request.expectedVersion) {
    return fail('签认冲突：该测段已被他人先行处理，请刷新后按最新状态操作')
  }
  const blocked = chainBlocked(request.recordId)
  if (blocked) {
    return fail(blocked)
  }

  const nextSegment = build(segment, record)
  const nextRecord: RecordSignoff = {
    ...record,
    segments: record.segments.map((item) => (item.id === segment.id ? nextSegment : item)),
    history: historyOf(nextSegment, record),
    historyVersion:
      target === '已签认' ? record.historyVersion + 1 : record.historyVersion,
  }
  const nextState = { ...state, [key]: nextRecord }
  const status = deriveRecordStatus(nextRecord.segments)
  const failed = persist(nextState, state, request.recordId, {
    status,
    pending: status !== '已通过',
  })
  if (failed) {
    return failed
  }
  return { ok: true, message: nextSegment.lastRequest?.message ?? `测段已流转为「${target}」` }
}

/** 测量员锁定原始读数：待锁定→已锁定，退回后重新锁定也走这里。 */
export function lockSegment(request: SignoffRequest): ActionResult {
  if (!isSurveyor(request.actor)) {
    return fail('锁定原始读数必须由测量员执行')
  }
  return transitionSegment(
    request,
    '已锁定',
    (segment) => {
      const message = `测段「${segment.name}」原始读数已由${request.actor}锁定`
      return {
        ...segment,
        status: '已锁定',
        lockedBy: request.actor,
        lockedAt: now(),
        version: segment.version + 1,
        lastRequest: { requestId: request.requestId, message },
      }
    },
    (_segment, record) => record.history,
  )
}

/** 审核员签认：已锁定→已签认，同时落一份历史签认版本。 */
export function signSegment(request: SignoffRequest): ActionResult {
  if (!isReviewer(request.actor)) {
    return fail('签认必须由审核员执行')
  }
  return transitionSegment(
    request,
    '已签认',
    (segment) => {
      const message = `测段「${segment.name}」已由${request.actor}签认`
      return {
        ...segment,
        status: '已签认',
        signedBy: request.actor,
        signedAt: now(),
        version: segment.version + 1,
        lastRequest: { requestId: request.requestId, message },
      }
    },
    (segment, record) => [
      ...record.history,
      {
        version: record.historyVersion + 1,
        segmentId: segment.id,
        segmentName: segment.name,
        signedBy: request.actor,
        signedAt: segment.signedAt ?? now(),
        method: record.method,
        area: record.area,
        reading: segment.reading,
      },
    ],
  )
}

/** 审核员退回：已锁定→已退回，必须填退回理由，测量员修改后重新锁定。 */
export function returnSegment(request: SignoffRequest): ActionResult {
  if (!isReviewer(request.actor)) {
    return fail('退回必须由审核员执行')
  }
  const reason = request.reason?.trim() ?? ''
  if (!reason) {
    return fail('退回必须填写退回理由')
  }
  return transitionSegment(
    request,
    '已退回',
    (segment) => {
      const message = `测段「${segment.name}」已由${request.actor}退回：${reason}`
      return {
        ...segment,
        status: '已退回',
        returnedBy: request.actor,
        returnedAt: now(),
        returnReason: reason,
        version: segment.version + 1,
        lastRequest: { requestId: request.requestId, message },
      }
    },
    (_segment, record) => record.history,
  )
}

/** 测量员修改原始读数：仅待锁定或已退回时可改，锁定后读数冻结。 */
export function updateReading(
  recordId: number,
  segmentId: string,
  reading: string,
  actor: string,
): ActionResult {
  if (!isSurveyor(actor)) {
    return fail('修改原始读数必须由测量员执行')
  }
  const value = reading.trim()
  if (!value) {
    return fail('原始读数不能为空')
  }
  const state = loadSignoffs()
  const found = findRecord(state, recordId)
  if (!found) {
    return fail('没有找到该流量记录的签认链路')
  }
  const segment = findSegment(found.record, segmentId)
  if (!segment) {
    return fail(`没有找到测段 ${segmentId}`)
  }
  if (segment.status !== '待锁定' && segment.status !== '已退回') {
    return fail(`测段「${segment.name}」已${segment.status}，原始读数不能再改`)
  }
  const blocked = chainBlocked(recordId)
  if (blocked) {
    return fail(blocked)
  }
  const nextRecord: RecordSignoff = {
    ...found.record,
    segments: found.record.segments.map((item) =>
      item.id === segmentId ? { ...item, reading: value, version: item.version + 1 } : item,
    ),
  }
  const failed = persist({ ...state, [found.key]: nextRecord }, state, recordId, null)
  return failed ?? { ok: true, message: `测段「${segment.name}」原始读数已更新为 ${value}` }
}

/**
 * 测量方法变更：旧过水面积不自动跟随，保留原值并标记待核对；
 * 历史签认版本仍按签认时的方法与面积留存，不回改。
 */
export function changeMethod(recordId: number, method: string, actor: string): ActionResult {
  if (!DISCHARGE_METHODS.includes(method)) {
    return fail(`未登记的测量方法「${method}」`)
  }
  const state = loadSignoffs()
  const found = findRecord(state, recordId)
  if (!found) {
    return fail('没有找到该流量记录的签认链路')
  }
  const blocked = chainBlocked(recordId)
  if (blocked) {
    return fail(blocked)
  }
  if (found.record.method === method) {
    return fail(`测量方法已经是「${method}」，不用重复变更`)
  }
  const nextRecord: RecordSignoff = {
    ...found.record,
    method,
    areaPendingCheck: true,
    areaCheckedBy: undefined,
    areaCheckedAt: undefined,
  }
  const failed = persist({ ...state, [found.key]: nextRecord }, state, recordId, {
    测量方法: method,
  })
  if (failed) {
    return failed
  }
  return {
    ok: true,
    message: `测量方法已由${actor}变更为「${method}」，原过水面积 ${found.record.area} 保留待核对，历史签认版本不受影响`,
  }
}

/** 审核员核对过水面积：确认原值或填入新值，清除待核对标记。 */
export function confirmArea(recordId: number, actor: string, area?: string): ActionResult {
  if (!isReviewer(actor)) {
    return fail('过水面积核对必须由审核员确认')
  }
  const state = loadSignoffs()
  const found = findRecord(state, recordId)
  if (!found) {
    return fail('没有找到该流量记录的签认链路')
  }
  if (!found.record.areaPendingCheck) {
    return fail('该记录没有待核对的过水面积')
  }
  const nextArea = area?.trim() ? area.trim() : found.record.area
  const nextRecord: RecordSignoff = {
    ...found.record,
    area: nextArea,
    areaPendingCheck: false,
    areaCheckedBy: actor,
    areaCheckedAt: now(),
  }
  const failed = persist({ ...state, [found.key]: nextRecord }, state, recordId, {
    过水面积: nextArea,
  })
  if (failed) {
    return failed
  }
  return { ok: true, message: `过水面积已由${actor}核对为 ${nextArea}，待核对标记已清除` }
}

export function getRecordSignoff(recordId: number): RecordSignoff | null {
  const state = loadSignoffs()
  return findRecord(state, recordId)?.record ?? null
}

/** 整编页「待核对成果」：方法已变更、过水面积尚未核对的流量记录。 */
export function listPendingCheckResults(): PendingCheckEntry[] {
  const state = loadSignoffs()
  const entries: PendingCheckEntry[] = []
  for (const row of listRows(DISCHARGE_KEY)) {
    const record = state[String(row.id)]
    if (!record || !record.areaPendingCheck) {
      continue
    }
    entries.push({
      recordId: Number(row.id),
      记录编号: String(row['记录编号'] ?? row.id),
      站点编号: String(row['站点编号'] ?? '—'),
      method: record.method,
      area: record.area,
      signedCount: record.segments.filter((item) => item.status === '已签认').length,
      segmentCount: record.segments.length,
      status: String(row.status),
    })
  }
  return entries
}
