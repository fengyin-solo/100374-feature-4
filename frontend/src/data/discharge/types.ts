/**
 * 流量监测「逐段签认」链路的领域类型。
 * 签认状态只能沿固定顺序流转；签认版本只追加、不改写，历史版本永久保留。
 */

// 顺序流转：草稿 → 已锁定 → 已签认；已锁定可退回修订，退回后重新锁定再签认。
export type SignoffStage = '草稿' | '已锁定' | '已签认' | '退回修订' | '异常值'

export type ReviewerRole = '测量员' | '审核员'

/** 测量员锁定的原始读数（一份不可变快照）。 */
export type DischargeReading = {
  测量方法: string
  断面流量: string
  最大流速: string
  过水面积: string
  测量时间: string
}

export type SealEventType = '锁定' | '签认' | '退回' | '标记异常' | '整编退回'

/** 签章事件：谁、什么时候、对哪个版本做了什么。 */
export type SealEvent = {
  type: SealEventType
  operator: string
  at: string
  note?: string
}

/** 逐段签认的一个版本：一次「锁定原始读数」生成一个版本，审核签认/退回都落在该版本上。 */
export type SignoffVersion = {
  version: number
  readings: DischargeReading
  lockedBy: string
  lockedAt: string
  status: '已锁定' | '已签认' | '已退回'
  events: SealEvent[]
}

export type DischargeRecord = {
  id: number
  记录编号: string
  站点编号: string
  stage: SignoffStage
  /** 乐观锁版本号：每次成功流转 +1，并发提交时用于 CAS 比对。 */
  rev: number
  /** 测量员的工作草稿，锁定后原样固化进版本。 */
  draft: DischargeReading
  /** 当前正在审核或最近签认的版本号（versions[*].version）。 */
  currentVersion: number | null
  /** 历史签认版本，只追加。 */
  versions: SignoffVersion[]
  /** 跨版本的完整签章时间线。 */
  timeline: SealEvent[]
  updatedAt: string
}

export type ActionOutcome = {
  ok: boolean
  message: string
  record?: DischargeRecord
}

export type DischargeAction = 'lock' | 'sign' | 'return' | 'abnormal' | 'reopen'
