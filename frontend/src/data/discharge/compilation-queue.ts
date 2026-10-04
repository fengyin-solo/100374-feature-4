/**
 * 整编页「待核对成果」队列：
 * 流量记录签认通过后流入；整编员可纳入整编，或退回重核（退回会在流量侧重开修订轮次）。
 * 队列项只记录指针与快照，不改动流量签认版本本身。
 */

import { buildRequestKey, getDischarge, listDischarge, submitDischarge } from './store'
import { nowStamp, signedVersion } from './domain'
import type { DischargeRecord, SignoffVersion } from './types'

const STORAGE_KEY = 'hydrology-monitor-station:compilation-checks'

export type CheckStatus = '待核对' | '已纳入' | '退回重核'

export type CompilationCheck = {
  id: string
  dischargeId: number
  记录编号: string
  站点编号: string
  测量方法: string
  断面流量: string
  过水面积: string
  签认人: string
  签认时间: string
  版本号: number
  status: CheckStatus
  updatedAt: string
  note?: string
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function makeCheck(record: DischargeRecord, version: SignoffVersion): CompilationCheck {
  const signEvent = [...version.events].reverse().find((event) => event.type === '签认')
  return {
    id: `CHK-${record.记录编号}-V${version.version}`,
    dischargeId: record.id,
    记录编号: record.记录编号,
    站点编号: record.站点编号,
    测量方法: version.readings.测量方法,
    断面流量: version.readings.断面流量,
    过水面积: version.readings.过水面积,
    签认人: signEvent?.operator ?? '',
    签认时间: signEvent?.at ?? version.lockedAt,
    版本号: version.version,
    status: '待核对',
    updatedAt: nowStamp(),
  }
}

/** 把一条已签认流量记录的指定版本登记为待核对成果；同记录同版本幂等。 */
export function upsertSignedCheck(dischargeId: number): CompilationCheck | null {
  const record = getDischarge(dischargeId)
  if (!record) {
    return null
  }
  const version = signedVersion(record)
  if (!version) {
    return null
  }
  const checks = loadRaw()
  const id = `CHK-${record.记录编号}-V${version.version}`
  const index = checks.findIndex((item) => item.id === id)
  const next = makeCheck(record, version)
  if (index >= 0) {
    // 同一记录同一版本已经纳入/退回过，保留整编侧的处置结论。
    return checks[index]
  }
  checks.push(next)
  persist(checks)
  return clone(next)
}

/** 首次打开整编页时，把所有已签认流量成果补登为待核对（历史版本兼容）。 */
function seedFromSigned(checks: CompilationCheck[]): CompilationCheck[] {
  let changed = false
  for (const record of listDischarge()) {
    const version = signedVersion(record)
    if (!version) {
      continue
    }
    const id = `CHK-${record.记录编号}-V${version.version}`
    if (!checks.some((item) => item.id === id)) {
      checks.push(makeCheck(record, version))
      changed = true
    }
  }
  if (changed) {
    persist(checks)
  }
  return checks
}

function loadRaw(): CompilationCheck[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as CompilationCheck[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persist(checks: CompilationCheck[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(checks))
  }
}

export function listChecks(): CompilationCheck[] {
  return clone(seedFromSigned(loadRaw()))
}

export function listPendingChecks(): CompilationCheck[] {
  return listChecks().filter((item) => item.status === '待核对')
}

/** 纳入整编：仅在待核对状态可操作，重复点击直接回放，不会重复纳入。 */
export function adoptCheck(id: string): { ok: boolean; message: string } {
  const checks = loadRaw()
  const index = checks.findIndex((item) => item.id === id)
  if (index < 0) {
    return { ok: false, message: '没有找到这份待核对成果' }
  }
  if (checks[index].status !== '待核对') {
    return { ok: false, message: `成果已${checks[index].status}，不能重复纳入` }
  }
  checks[index] = {
    ...checks[index],
    status: '已纳入',
    updatedAt: nowStamp(),
  }
  persist(checks)
  return { ok: true, message: `成果 ${id} 已纳入整编` }
}

/**
 * 退回重核：整编侧标记退回，并在流量签认侧重开修订轮次（CAS 保证原子一致）。
 * 任一侧失败都不落库，不出现「整编退回了、流量侧却还挂已签认」的半份状态。
 */
export function rejectCheck(
  id: string,
  operator: string,
  reason: string,
): { ok: boolean; message: string } {
  const checks = loadRaw()
  const index = checks.findIndex((item) => item.id === id)
  if (index < 0) {
    return { ok: false, message: '没有找到这份待核对成果' }
  }
  if (checks[index].status !== '待核对') {
    return { ok: false, message: `成果已${checks[index].status}，不能再退回` }
  }

  // 先走流量侧重开修订（内部 CAS 校验 + 失败不写库）。
  const record = getDischarge(checks[index].dischargeId)
  if (!record) {
    return { ok: false, message: '对应的流量记录不存在' }
  }
  const outcome = submitDischarge({
    id: record.id,
    action: 'reopen',
    expectedRev: record.rev,
    operator,
    note: reason,
    requestKey: buildRequestKey(record.id, 'reopen', record.rev, operator),
  })
  if (!outcome.ok) {
    return { ok: false, message: outcome.message }
  }

  checks[index] = {
    ...checks[index],
    status: '退回重核',
    updatedAt: nowStamp(),
    note: reason,
  }
  persist(checks)
  return { ok: true, message: `成果 ${id} 已退回重核，流量侧已重开修订轮次` }
}
