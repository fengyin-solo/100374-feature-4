import { SIGNOFF_SEED } from './signoff-seed'
import type { RecordSignoff } from './types'

// 流量监测签认链路的本地持久化：与业务记录分开存放，历史签认版本随记录一起留存。
// 每次操作都从 localStorage 新鲜读取，不用模块级缓存，这样并发签认的版本检查才有效。
const STORAGE_KEY = 'hydrology-monitor-station:discharge-signoffs'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function loadSignoffs(): Record<string, RecordSignoff> {
  const fallback = clone(SIGNOFF_SEED)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, RecordSignoff>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

export function saveSignoffs(state: Record<string, RecordSignoff>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetSignoffs(): Record<string, RecordSignoff> {
  const state = clone(SIGNOFF_SEED)
  saveSignoffs(state)
  return state
}

export function signoffStorageKey(): string {
  return STORAGE_KEY
}
