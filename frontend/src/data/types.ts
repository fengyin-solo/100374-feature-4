/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ---- 流量监测逐段签认 ----

/** 测段签认状态：只能按 待锁定→已锁定→已签认 顺序流转，已锁定可退回，退回后重新锁定。 */
export type SegmentStatus = '待锁定' | '已锁定' | '已签认' | '已退回'

export type SignoffSegment = {
  id: string
  name: string
  /** 原始读数，锁定后冻结，退回或待锁定时测量员可改。 */
  reading: string
  status: SegmentStatus
  /** 乐观锁版本号：并发签认时后到的请求因版本不一致被拒绝。 */
  version: number
  lockedBy?: string
  lockedAt?: string
  signedBy?: string
  signedAt?: string
  returnedBy?: string
  returnedAt?: string
  returnReason?: string
  /** 幂等键：连续提交只认首次结果，同一 requestId 重放首次结论。 */
  lastRequest?: { requestId: string; message: string }
}

/** 历史签认版本：签认那一刻的方法、面积、读数快照，方法变更后不回改。 */
export type SignoffVersion = {
  version: number
  segmentId: string
  segmentName: string
  signedBy: string
  signedAt: string
  method: string
  area: string
  reading: string
}

export type RecordSignoff = {
  recordId: number
  method: string
  area: string
  /** 测量方法变更后旧过水面积不自动跟随，置为待核对，核对前不进整编。 */
  areaPendingCheck: boolean
  areaCheckedBy?: string
  areaCheckedAt?: string
  historyVersion: number
  segments: SignoffSegment[]
  history: SignoffVersion[]
}

/** 整编页「待核对成果」条目。 */
export type PendingCheckEntry = {
  recordId: number
  记录编号: string
  站点编号: string
  method: string
  area: string
  signedCount: number
  segmentCount: number
  status: string
}
