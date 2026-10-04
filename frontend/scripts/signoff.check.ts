/**
 * 签认链路核心规则验证（在 src 之外，不进应用构建与 vue-tsc）。
 * 用内存版 localStorage 驱动 store 层，覆盖：状态机顺序、并发 CAS、
 * 幂等连续提交、过水面积沿用、失败原子性、历史版本兼容、旧数据迁移、整编退回。
 */
import assert from 'node:assert'

// ---- 内存 localStorage ----
const mem = new Map<string, string>()
;(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
}

import * as domain from '../src/data/discharge/domain'
import * as store from '../src/data/discharge/store'
import * as queue from '../src/data/discharge/compilation-queue'

function restart() {
  // 重置模块缓存的数据与 localStorage，等价于全新用户。
  mem.clear()
  store.resetDischarge()
}

// 1) 顺序流转：草稿必须先锁定才能签认，不能跳段
{
  let rec = domain.migrateLegacyRow({
    id: 1,
    status: '已采集',
    记录编号: 'DISC-X1',
    测量方法: '流速仪法',
    断面流量: '10',
    最大流速: '1',
    过水面积: '10',
    测量时间: '2026-10-01',
  })
  assert.equal(rec.stage, '草稿')
  assert.throws(
    () => domain.signRecord({ record: rec, expectedRev: rec.rev, reviewer: 'r' }),
    /不能执行该签认操作/,
    '草稿不能直接签认',
  )
  rec = domain.lockReadings({ record: rec, expectedRev: 0, surveyor: 's', draft: rec.draft })
  assert.equal(rec.stage, '已锁定')
  assert.equal(rec.rev, 1)
  assert.throws(
    () => domain.lockReadings({ record: rec, expectedRev: rec.rev, surveyor: 's', draft: rec.draft }),
    /不能执行/,
    '已锁定不能重复锁定',
  )
  const signed = domain.signRecord({ record: rec, expectedRev: 1, reviewer: '审核员·王芳' })
  assert.equal(signed.stage, '已签认')
  assert.equal(signed.versions[0].status, '已签认')
  console.log('✓ 状态机只能顺序流转，跳段操作被拒')
}

// 2) 退回 → 重新锁定生成新版本，老版本保留（历史版本兼容），过水面积沿用
{
  let rec = domain.migrateLegacyRow({
    id: 2,
    status: '已通过',
    记录编号: 'DISC-X2',
    测量方法: '流速仪法',
    断面流量: '20',
    最大流速: '2',
    过水面积: '88.8',
    测量时间: '2026-09-20',
  })
  assert.equal(rec.stage, '已签认')
  assert.equal(rec.versions[0].status, '已签认', '旧已通过数据迁移为已签认历史版本')
  rec = domain.reopenFromCompilation({
    record: rec,
    expectedRev: rec.rev,
    reviewer: '整编员',
    reason: '整编核对退回',
  })
  assert.equal(rec.stage, '退回修订')
  assert.equal(rec.versions[0].status, '已签认', '整编退回不抹掉历史签认版本')

  // 测量员把方法改成浮标法，并试图改面积——领域层强制沿用 88.8
  rec = domain.lockReadings({
    record: rec,
    expectedRev: rec.rev,
    surveyor: '测量员·周涛',
    draft: { ...rec.draft, 测量方法: '浮标法', 过水面积: '1.0' },
  })
  assert.equal(rec.stage, '已锁定')
  assert.equal(rec.versions.length, 2)
  assert.equal(rec.versions[1].readings.测量方法, '浮标法')
  assert.equal(rec.versions[1].readings.过水面积, '88.8', '测量方法变更时旧过水面积跟随沿用')
  assert.equal(rec.versions[0].readings.过水面积, '88.8', '历史版本快照不变')
  rec = domain.signRecord({ record: rec, expectedRev: rec.rev, reviewer: '审核员·赵磊' })
  assert.equal(rec.stage, '已签认')
  assert.equal(rec.versions[0].status, '已签认')
  assert.equal(rec.versions[1].status, '已签认')
  console.log('✓ 退回重锁生成新版本，历史签认版本与旧面积快照均保留')
}

// 3) 两名审核员同版本并发签认，只有一个有效签章
restart()
{
  const target = store.getDischarge(2)! // 内置「已锁定」种子，rev=2
  const rev = target.rev
  const a = store.submitDischarge({
    id: 2,
    action: 'sign',
    expectedRev: rev,
    operator: '审核员·王芳',
    requestKey: store.buildRequestKey(2, 'sign', rev, '审核员·王芳'),
  })
  const b = store.submitDischarge({
    id: 2,
    action: 'sign',
    expectedRev: rev,
    operator: '审核员·赵磊',
    requestKey: store.buildRequestKey(2, 'sign', rev, '审核员·赵磊'),
  })
  assert.equal(a.ok, true)
  assert.equal(b.ok, false, '第二签章必须被 CAS 拒绝')
  assert.match(b.message, /已被他人改动/)
  const after = store.getDischarge(2)!
  const seals = after.versions
    .find((v) => v.version === after.currentVersion)!
    .events.filter((e) => e.type === '签认')
  assert.equal(seals.length, 1, '只落了一个有效签章')
  assert.equal(seals[0].operator, '审核员·王芳')
  console.log('✓ 两名审核员并发签认只接受一个有效签章')
}

// 4) 连续相同提交只认首次结果（幂等台账）
restart()
{
  const t = store.getDischarge(2)!
  const key = store.buildRequestKey(2, 'sign', t.rev, '审核员·王芳')
  const args = {
    id: 2,
    action: 'sign' as const,
    expectedRev: t.rev,
    operator: '审核员·王芳',
    requestKey: key,
  }
  const first = store.submitDischarge(args)
  const second = store.submitDischarge(args)
  assert.equal(first.ok, true)
  assert.equal(second.message, first.message, '重复提交回放首次结果')
  const rec = store.getDischarge(2)!
  assert.equal(rec.timeline.filter((e) => e.type === '签认').length, 1, '没有第二个签章')
  console.log('✓ 连续相同提交只认首次结果')
}

// 5) 流转失败不留半份签认：先退回，另一人拿旧 rev 签认
restart()
{
  const t = store.getDischarge(2)!
  const rev = t.rev
  const ret = store.submitDischarge({
    id: 2,
    action: 'return',
    expectedRev: rev,
    operator: '审核员·王芳',
    note: '数据存疑',
    requestKey: store.buildRequestKey(2, 'return', rev, '审核员·王芳'),
  })
  assert.equal(ret.ok, true)
  const sign = store.submitDischarge({
    id: 2,
    action: 'sign',
    expectedRev: rev,
    operator: '审核员·赵磊',
    requestKey: store.buildRequestKey(2, 'sign', rev, '审核员·赵磊'),
  })
  assert.equal(sign.ok, false)
  const rec = store.getDischarge(2)!
  assert.equal(rec.stage, '退回修订', '失败后状态仍是退回修订')
  assert.equal(rec.currentVersion, null)
  assert.equal(rec.timeline.filter((e) => e.type === '签认').length, 0, '失败没有留下任何签章')
  console.log('✓ 失败不留下半份签认（状态/版本/时间线均无脏写）')
}

// 6) 读数不全不允许锁定
{
  const rec = domain.migrateLegacyRow({ id: 9, status: '已采集' })
  assert.throws(
    () => domain.lockReadings({ record: rec, expectedRev: 0, surveyor: 's', draft: rec.draft }),
    /未填写完整/,
  )
  console.log('✓ 原始读数不完整不能锁定')
}

// 7) 旧数据迁移：待审核 → 已锁定待签认；异常值 → 异常值
{
  const waiting = domain.migrateLegacyRow({ id: 3, status: '待审核' })
  assert.equal(waiting.stage, '已锁定')
  assert.equal(waiting.currentVersion, 1)
  assert.equal(waiting.versions[0].status, '已锁定')
  const abnormal = domain.migrateLegacyRow({ id: 4, status: '异常值' })
  assert.equal(abnormal.stage, '异常值')
  assert.equal(abnormal.versions.length, 0)
  console.log('✓ 历史签认版本兼容：旧扁平数据惰性迁移为签认结构')
}

// 8) 待核对成果：签认后流入，纳入/退回；退回重开流量修订且不留半份
restart()
{
  const t = store.getDischarge(2)!
  const signed = store.submitDischarge({
    id: 2,
    action: 'sign',
    expectedRev: t.rev,
    operator: '审核员·王芳',
    requestKey: store.buildRequestKey(2, 'sign', t.rev, '审核员·王芳'),
  })
  assert.equal(signed.ok, true)
  queue.upsertSignedCheck(2)
  const pending = queue.listPendingChecks().filter((c) => c.dischargeId === 2)
  assert.equal(pending.length, 1)
  const checkId = pending[0].id

  // 重复登记同一记录版本，幂等不新增
  queue.upsertSignedCheck(2)
  assert.equal(queue.listPendingChecks().filter((c) => c.dischargeId === 2).length, 1)

  const rejected = queue.rejectCheck(checkId, '整编员·孙倩', '整编存疑，重核')
  assert.equal(rejected.ok, true)
  const flow = store.getDischarge(2)!
  assert.equal(flow.stage, '退回修订', '退回重核在流量侧重开修订轮次')
  assert.equal(flow.currentVersion, null)
  assert.equal(flow.versions[0].status, '已签认', '历史签认版本仍保留')
  assert.equal(
    queue.listChecks().find((c) => c.id === checkId)!.status,
    '退回重核',
  )
  // 已退回的成果不能再纳入，重复退回也被拒
  assert.equal(queue.adoptCheck(checkId).ok, false)
  assert.equal(queue.rejectCheck(checkId, '整编员·孙倩', '再来一次').ok, false)

  // 另一条签认成果纳入整编
  const adoptTarget = queue
    .listPendingChecks()
    .find((c) => c.dischargeId === 3) // 内置已签认种子，seedFromSigned 自动补登
  assert.ok(adoptTarget, '已签认历史成果自动补登为待核对')
  assert.equal(queue.adoptCheck(adoptTarget!.id).ok, true)
  assert.equal(queue.adoptCheck(adoptTarget!.id).ok, false, '不能重复纳入')
  console.log('✓ 整编页待核对成果：签认流入、纳入/退回重核均符合预期')
}

// 9) 签章与幂等台账持久化（读 localStorage 原始内容确认落盘）
restart()
{
  const t = store.getDischarge(2)!
  store.submitDischarge({
    id: 2,
    action: 'sign',
    expectedRev: t.rev,
    operator: '审核员·王芳',
    requestKey: store.buildRequestKey(2, 'sign', t.rev, '审核员·王芳'),
  })
  const raw = JSON.parse(mem.get('hydrology-monitor-station:discharge-signoff')!)
  assert.equal(raw.records.find((r: { id: number }) => r.id === 2).stage, '已签认')
  assert.ok(Object.keys(raw.ledger).length >= 1, '幂等台账已落盘')
  console.log('✓ 签章与幂等台账持久化到 localStorage')
}

console.log('\n全部签认链路规则验证通过 ✅')
