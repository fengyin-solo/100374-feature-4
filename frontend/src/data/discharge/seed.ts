/** 流量逐段签认链路的内置数据：覆盖草稿、已锁定、已签认、退回修订四段。 */

import type { DischargeRecord, DischargeReading } from './types'

function reading(method: string, flow: string, speed: string, area: string, at: string): DischargeReading {
  return {
    测量方法: method,
    断面流量: flow,
    最大流速: speed,
    过水面积: area,
    测量时间: at,
  }
}

export const DISCHARGE_SEED: DischargeRecord[] = [
  {
    id: 1,
    记录编号: 'DISC-0001',
    站点编号: 'STAT-07',
    stage: '草稿',
    rev: 0,
    draft: reading('转子式流速仪法', '', '2.14', '126.5', '2026-10-03 08:30'),
    currentVersion: null,
    versions: [],
    timeline: [],
    updatedAt: '2026-10-03T08:30:00.000Z',
  },
  {
    id: 2,
    记录编号: 'DISC-0002',
    站点编号: 'STAT-03',
    stage: '已锁定',
    rev: 2,
    draft: reading('声学多普勒法', '184.6', '2.68', '68.9', '2026-10-02 09:10'),
    currentVersion: 1,
    versions: [
      {
        version: 1,
        readings: reading('声学多普勒法', '184.6', '2.68', '68.9', '2026-10-02 09:10'),
        lockedBy: '测量员·李明',
        lockedAt: '2026-10-02T09:12:00.000Z',
        status: '已锁定',
        events: [{ type: '锁定', operator: '测量员·李明', at: '2026-10-02T09:12:00.000Z' }],
      },
    ],
    timeline: [
      { type: '锁定', operator: '测量员·李明', at: '2026-10-02T09:12:00.000Z' },
    ],
    updatedAt: '2026-10-02T09:12:00.000Z',
  },
  {
    id: 3,
    记录编号: 'DISC-0003',
    站点编号: 'STAT-03',
    stage: '已签认',
    rev: 4,
    draft: reading('声学多普勒法', '176.2', '2.55', '68.9', '2026-09-28 14:05'),
    currentVersion: 1,
    versions: [
      {
        version: 1,
        readings: reading('声学多普勒法', '176.2', '2.55', '68.9', '2026-09-28 14:05'),
        lockedBy: '测量员·李明',
        lockedAt: '2026-09-28T14:10:00.000Z',
        status: '已签认',
        events: [
          { type: '锁定', operator: '测量员·李明', at: '2026-09-28T14:10:00.000Z' },
          { type: '签认', operator: '审核员·王芳', at: '2026-09-28T15:02:00.000Z' },
        ],
      },
    ],
    timeline: [
      { type: '锁定', operator: '测量员·李明', at: '2026-09-28T14:10:00.000Z' },
      { type: '签认', operator: '审核员·王芳', at: '2026-09-28T15:02:00.000Z' },
    ],
    updatedAt: '2026-09-28T15:02:00.000Z',
  },
  {
    id: 4,
    记录编号: 'DISC-0004',
    站点编号: 'STAT-11',
    stage: '退回修订',
    rev: 5,
    // 方法改成了浮标法，过水面积仍沿用上一轮锁定的 92.4（方法变、面积不跟随变动）。
    draft: reading('浮标法', '243.0', '3.02', '92.4', '2026-10-01 16:40'),
    currentVersion: null,
    versions: [
      {
        version: 1,
        readings: reading('转子式流速仪法', '251.8', '3.11', '92.4', '2026-10-01 16:20'),
        lockedBy: '测量员·周涛',
        lockedAt: '2026-10-01T16:25:00.000Z',
        status: '已退回',
        events: [
          { type: '锁定', operator: '测量员·周涛', at: '2026-10-01T16:25:00.000Z' },
          { type: '退回', operator: '审核员·王芳', at: '2026-10-01T17:00:00.000Z', note: '浮标系数与测验规范不符，请复测' },
        ],
      },
    ],
    timeline: [
      { type: '锁定', operator: '测量员·周涛', at: '2026-10-01T16:25:00.000Z' },
      { type: '退回', operator: '审核员·王芳', at: '2026-10-01T17:00:00.000Z', note: '浮标系数与测验规范不符，请复测' },
    ],
    updatedAt: '2026-10-01T17:00:00.000Z',
  },
]
