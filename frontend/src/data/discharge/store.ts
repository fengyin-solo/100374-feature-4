/**
 * 流量签认链路的存储层：
 * - 独立 localStorage 键，首次使用从内置种子播种；
 * - 旧版通用 EntryRow（扁平结构）惰性迁移成签认记录；
 * - 每次成功流转整记录原子写入，失败不写库，不留半份签认；
 * - 幂等台账：同一个提交键连续提交只认首次结果（含失败结果）。
 */

import { listRows, resetRows } from '@/data/local-store'
import {
  DomainError,
  lockReadings,
  markAbnormal,
  migrateLegacyRow,
  reopenFromCompilation,
  returnRecord,
  signRecord,
} from './domain'
import { DISCHARGE_SEED } from './seed'
import type {
  ActionOutcome,
  DischargeAction,
  DischargeRecord,
} from './types'

const STORAGE_KEY = 'hydrology-monitor-station:discharge-signoff'
const LEGACY_KEY = 'discharge'

type LedgerEntry = {
  outcome: ActionOutcome
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: DischargeRecord[] | null = null
let ledger: Record<string, LedgerEntry> = {}

function persist(records: DischargeRecord[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ records, ledger }))
  }
}

/**
 * 加载记录：优先用新版签认数据；没有就从旧版通用存储迁移（已签认的补录历史签章）；
 * 两边都没有时使用内置种子。迁移结果立即落库，刷新不丢。
 */
function load(): DischargeRecord[] {
  if (cache) {
    return cache
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as {
          records?: DischargeRecord[]
          ledger?: Record<string, LedgerEntry>
        }
        cache = Array.isArray(parsed.records) ? parsed.records : clone(DISCHARGE_SEED)
        ledger = parsed.ledger ?? {}
        return cache
      } catch {
        // 数据损坏时落到迁移/种子逻辑，不使用半截数据。
      }
    }
  }

  const legacy = listRows(LEGACY_KEY)
  if (legacy.length > 0) {
    cache = legacy.map((row) => migrateLegacyRow(row))
    persist(cache)
    return cache
  }

  cache = clone(DISCHARGE_SEED)
  persist(cache)
  return cache
}

export function listDischarge(): DischargeRecord[] {
  return clone(load())
}

export function getDischarge(id: number): DischargeRecord | null {
  const found = load().find((item) => item.id === id)
  return found ? clone(found) : null
}

export function resetDischarge(): DischargeRecord[] {
  cache = clone(DISCHARGE_SEED)
  ledger = {}
  persist(cache)
  // 通用存储也一并复位，保证迁移来源一致。
  resetRows(LEGACY_KEY)
  return clone(cache)
}

/**
 * 提交一次签认流转。
 * requestKey 由调用方按「记录 + 动作 + 当前版本 + 操作人」生成，
 * 连续重复提交直接回放首次结果，不再产生第二个签章。
 */
export function submitDischarge(input: {
  id: number
  action: DischargeAction
  expectedRev: number
  operator: string
  requestKey?: string
  draft?: DischargeRecord['draft']
  note?: string
}): ActionOutcome {
  const records = load()

  if (input.requestKey && ledger[input.requestKey]) {
    return clone(ledger[input.requestKey].outcome)
  }

  const index = records.findIndex((item) => item.id === input.id)
  if (index < 0) {
    const outcome: ActionOutcome = {
      ok: false,
      message: `没有找到编号为 ${input.id} 的流量记录`,
    }
    if (input.requestKey) {
      ledger[input.requestKey] = { outcome: clone(outcome) }
      persist(records)
    }
    return outcome
  }

  let outcome: ActionOutcome
  try {
    const current = records[index]
    let next: DischargeRecord
    switch (input.action) {
      case 'lock':
        if (!input.draft) {
          throw new DomainError('缺少待锁定的原始读数')
        }
        next = lockReadings({
          record: current,
          expectedRev: input.expectedRev,
          surveyor: input.operator,
          draft: input.draft,
        })
        break
      case 'sign':
        next = signRecord({
          record: current,
          expectedRev: input.expectedRev,
          reviewer: input.operator,
          note: input.note,
        })
        break
      case 'return':
        next = returnRecord({
          record: current,
          expectedRev: input.expectedRev,
          reviewer: input.operator,
          reason: input.note,
        })
        break
      case 'abnormal':
        next = markAbnormal({
          record: current,
          expectedRev: input.expectedRev,
          surveyor: input.operator,
          reason: input.note,
        })
        break
      case 'reopen':
        next = reopenFromCompilation({
          record: current,
          expectedRev: input.expectedRev,
          reviewer: input.operator,
          reason: input.note,
        })
        break
      default:
        throw new DomainError(`未知签认动作：${String(input.action)}`)
    }

    // 成功：整记录原子替换并一次性落库。
    records[index] = next
    persist(records)
    outcome = {
      ok: true,
      message: `记录 ${next.记录编号} 已${actionLabel(input.action)}，当前状态「${next.stage}」`,
      record: clone(next),
    }
  } catch (error) {
    // 失败：不改动 records、不落业务数据，绝不留半份签认。
    outcome = {
      ok: false,
      message:
        error instanceof DomainError ? error.message : '签认流转失败，请重试',
    }
  }

  if (input.requestKey) {
    ledger[input.requestKey] = { outcome: clone(outcome) }
    persist(records)
  }
  return outcome
}

function actionLabel(action: DischargeAction): string {
  return {
    lock: '锁定原始读数',
    sign: '签认',
    return: '退回修订',
    abnormal: '标记异常',
    reopen: '退回重核',
  }[action]
}

export function buildRequestKey(
  id: number,
  action: DischargeAction,
  rev: number,
  operator: string,
): string {
  return `${id}:${action}:${rev}:${operator}`
}

export function exportDischargeCsv(): { filename: string; content: string } {
  const header = ['记录编号', '站点编号', '测量方法', '断面流量', '最大流速', '过水面积', '测量时间', '签认版本', '签认状态']
  const lines = [header.join(',')]
  for (const row of listDischarge()) {
    const version = row.currentVersion
      ? row.versions.find((item) => item.version === row.currentVersion)
      : undefined
    const readings = version?.readings ?? row.draft
    lines.push(
      [
        row.记录编号,
        row.站点编号,
        readings.测量方法,
        readings.断面流量,
        readings.最大流速,
        readings.过水面积,
        readings.测量时间,
        row.versions.length,
        row.stage,
      ].join(','),
    )
  }
  return { filename: '流量监测-签认清单.csv', content: `﻿${lines.join('\n')}` }
}
