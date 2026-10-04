<template>
  <section class="page" data-module="discharge">
    <header class="page-head">
      <div>
        <h2>流量监测管理</h2>
        <p class="page-desc">
          逐段签认：测量员先锁定原始读数，审核员再签认或退回；签认状态只能顺序流转，历史签认版本只追加不改写。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openDemo">并发签认演示</button>
        <button class="btn" type="button" @click="exportRows">导出流量监测清单</button>
      </div>
    </header>

    <div class="role-bar">
      <span class="role-label">当前身份</span>
      <button
        v-for="item in roles"
        :key="item"
        class="role-chip"
        :class="{ active: role === item }"
        type="button"
        @click="role = item"
      >
        {{ item }}
      </button>
      <label class="role-name">
        <span>签章人</span>
        <input v-model="operatorName" type="text" />
      </label>
      <button class="btn ghost" type="button" @click="reseed">恢复演示数据</button>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent>
      <label class="filter-item">
        <span>记录编号</span>
        <input v-model="keyword" placeholder="按记录编号 / 站点编号检索" />
      </label>
      <button class="btn" type="button" @click="keyword = ''">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>记录编号</th>
          <th>站点编号</th>
          <th>测量方法</th>
          <th>断面流量</th>
          <th>最大流速</th>
          <th>过水面积</th>
          <th>测量时间</th>
          <th>版本</th>
          <th>签认状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="row.id">
          <td>{{ row.记录编号 }}</td>
          <td>{{ row.站点编号 }}</td>
          <td>{{ activeReading(row).测量方法 }}</td>
          <td>{{ activeReading(row).断面流量 || '—' }}</td>
          <td>{{ activeReading(row).最大流速 }}</td>
          <td>{{ activeReading(row).过水面积 }}</td>
          <td>{{ activeReading(row).测量时间 }}</td>
          <td>
            {{ row.versions.length }} 版
            <button class="link" type="button" @click="openHistory(row)">版本历史</button>
          </td>
          <td><span class="stage-badge" :class="stageClass(row.stage)">{{ row.stage }}</span></td>
          <td class="row-actions">
            <template v-if="canSurvey(row)">
              <button class="link" type="button" @click="openLock(row)">锁定原始读数</button>
              <button class="link danger" type="button" @click="runMarkAbnormal(row)">标记异常</button>
            </template>
            <template v-if="canReview(row)">
              <button class="link" type="button" @click="openReview(row)">审核签认 / 退回</button>
            </template>
            <span v-if="!canSurvey(row) && !canReview(row)" class="muted-text">
              {{ role === '测量员' ? '待审核员处理' : '等待测量员锁定' }}
            </span>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td colspan="10" class="empty-state">暂无符合条件的流量监测记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条流量监测记录 · 数据版本号 rev 用于并发签章比对</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 测量员锁定原始读数 -->
    <div v-if="lockTarget" class="modal-mask" @click.self="lockTarget = null">
      <div class="modal">
        <h3>锁定原始读数 · {{ lockTarget.记录编号 }}</h3>
        <p class="modal-tip">
          锁定后读数固化为第 {{ lockTarget.versions.length + 1 }} 版，审核员才能签认；
          <strong>过水面积为断面几何量，测量方法变更时沿用旧面积（{{ areaHint }}）</strong>，不随方法变动。
        </p>
        <label class="form-item">
          <span>测量方法</span>
          <input v-model="lockForm.测量方法" type="text" />
        </label>
        <label class="form-item">
          <span>断面流量 (m³/s)</span>
          <input v-model="lockForm.断面流量" type="text" />
        </label>
        <label class="form-item">
          <span>最大流速 (m/s)</span>
          <input v-model="lockForm.最大流速" type="text" />
        </label>
        <label class="form-item">
          <span>过水面积 (m²) · {{ areaHint ? '沿用旧值，锁定' : '首次锁定可填' }}</span>
          <input v-model="lockForm.过水面积" type="text" :readonly="areaLocked" :class="{ readonly: areaLocked }" />
        </label>
        <label class="form-item">
          <span>测量时间</span>
          <input v-model="lockForm.测量时间" type="text" />
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="lockTarget = null">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="confirmLock">
            锁定并提交审核
          </button>
        </div>
      </div>
    </div>

    <!-- 审核员签认 / 退回 -->
    <div v-if="reviewTarget" class="modal-mask" @click.self="reviewTarget = null">
      <div class="modal">
        <h3>审核签认 · {{ reviewTarget.记录编号 }}（第 {{ reviewTarget.currentVersion }} 版）</h3>
        <dl class="reading-panel">
          <template v-for="item in readingEntries(reviewSnapshot)" :key="item[0]">
            <dt>{{ item[0] }}</dt>
            <dd>{{ item[1] }}</dd>
          </template>
          <dt>锁定人</dt>
          <dd>{{ reviewVersion?.lockedBy }} · {{ formatTime(reviewVersion?.lockedAt) }}</dd>
        </dl>
        <label class="form-item">
          <span>审核意见（签认备注 / 退回原因）</span>
          <textarea v-model="reviewNote" rows="3"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="reviewTarget = null">取消</button>
          <button class="btn danger" type="button" :disabled="submitting" @click="confirmReturn">退回修订</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="confirmSign">签认通过</button>
        </div>
      </div>
    </div>

    <!-- 版本历史 -->
    <div v-if="historyTarget" class="modal-mask wide" @click.self="historyTarget = null">
      <div class="modal">
        <h3>签认版本历史 · {{ historyTarget.记录编号 }}</h3>
        <div v-for="version in [...historyTarget.versions].reverse()" :key="version.version" class="version-card">
          <header>
            <strong>第 {{ version.version }} 版</strong>
            <span class="stage-badge" :class="stageClass(version.status)">{{ version.status }}</span>
            <span class="muted-text">{{ version.lockedBy }} 锁定于 {{ formatTime(version.lockedAt) }}</span>
          </header>
          <dl class="reading-panel compact">
            <template v-for="item in readingEntries(version.readings)" :key="item[0]">
              <dt>{{ item[0] }}</dt>
              <dd>{{ item[1] }}</dd>
            </template>
          </dl>
          <ul class="event-list">
            <li v-for="(event, idx) in version.events" :key="idx">
              <span class="event-type" :class="`event-${event.type}`">{{ event.type }}</span>
              {{ event.operator }} · {{ formatTime(event.at) }}
              <em v-if="event.note">：{{ event.note }}</em>
            </li>
          </ul>
        </div>
        <p v-if="!historyTarget.versions.length" class="empty-state">尚未锁定任何版本</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="historyTarget = null">关闭</button>
        </div>
      </div>
    </div>

    <!-- 并发 / 连续提交演示 -->
    <div v-if="demoOpen" class="modal-mask wide" @click.self="demoOpen = false">
      <div class="modal">
        <h3>并发签认与连续提交演示</h3>
        <p class="modal-tip">
          用「{{ demoRecord?.记录编号 }}」当前 rev={{ demoRecord?.rev }} 做演示：
          两名审核员各持同一版本同时签认，只有第一个签章有效；同一请求连续提交只认首次结果。
        </p>
        <div class="demo-actions">
          <button class="btn primary" type="button" :disabled="demoBusy" @click="runConcurrentSign">
            两名审核员并发签认
          </button>
          <button class="btn" type="button" :disabled="demoBusy" @click="runDuplicateSubmit">
            同一签章连续提交两次
          </button>
          <button class="btn danger" type="button" :disabled="demoBusy" @click="runSignAfterReturn">
            退回后再签认（失败不留痕）
          </button>
        </div>
        <ol class="demo-log">
          <li v-for="(line, idx) in demoLog" :key="idx" :class="line.kind">{{ line.text }}</li>
        </ol>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="demoOpen = false">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  buildRequestKey,
  exportDischargeCsv,
  listDischarge,
  resetDischarge,
  submitDischarge,
} from '@/data/discharge/store'
import { latestLockedVersion } from '@/data/discharge/domain'
import { upsertSignedCheck } from '@/data/discharge/compilation-queue'
import type {
  DischargeReading,
  DischargeRecord,
  ReviewerRole,
  SignoffVersion,
} from '@/data/discharge/types'

const stages = ['草稿', '已锁定', '已签认', '退回修订', '异常值']

const roles: ReviewerRole[] = ['测量员', '审核员']
const role = ref<ReviewerRole>('测量员')
const operatorName = ref('测量员·李明')

const rows = ref<DischargeRecord[]>([])
const keyword = ref('')
const message = ref('')
const messageOk = ref(true)
const submitting = ref(false)

function reload() {
  rows.value = listDischarge()
}

function setMessage(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

const filteredRows = computed(() => {
  const word = keyword.value.trim()
  if (!word) {
    return rows.value
  }
  return rows.value.filter(
    (row) => row.记录编号.includes(word) || row.站点编号.includes(word),
  )
})

const statusSummary = computed(() =>
  stages.map((status) => ({
    status,
    count: rows.value.filter((row) => row.stage === status).length,
  })),
)

const stats = computed(() => [
  { label: '在测记录总数', value: rows.value.length },
  { label: '测量员待锁定', value: rows.value.filter((row) => ['草稿', '退回修订'].includes(row.stage)).length },
  { label: '审核员待签认', value: rows.value.filter((row) => row.stage === '已锁定').length },
  { label: '异常记录数', value: rows.value.filter((row) => row.stage === '异常值').length },
])

/** 当前展示的读数：锁定/签认中看当前版本，其他阶段看工作草稿。 */
function activeReading(row: DischargeRecord): DischargeReading {
  if (row.stage === '已锁定' || row.stage === '已签认') {
    const version = row.versions.find((item) => item.version === row.currentVersion)
    if (version) {
      return version.readings
    }
  }
  const latest = latestLockedVersion(row)
  if (latest && (row.stage === '退回修订' || row.stage === '异常值')) {
    return { ...latest.readings, ...row.draft }
  }
  return row.draft
}

function stageClass(stage: string): string {
  return {
    草稿: 'stage-draft',
    已锁定: 'stage-locked',
    已签认: 'stage-signed',
    退回修订: 'stage-returned',
    异常值: 'stage-abnormal',
  }[stage] ?? ''
}

function canSurvey(row: DischargeRecord): boolean {
  return role.value === '测量员' && (row.stage === '草稿' || row.stage === '退回修订')
}

function canReview(row: DischargeRecord): boolean {
  return role.value === '审核员' && row.stage === '已锁定'
}

// ---------- 测量员锁定 ----------

const lockTarget = ref<DischargeRecord | null>(null)
const lockForm = ref<DischargeReading>({
  测量方法: '',
  断面流量: '',
  最大流速: '',
  过水面积: '',
  测量时间: '',
})

const areaHint = computed(() => {
  if (!lockTarget.value) {
    return ''
  }
  return latestLockedVersion(lockTarget.value)?.readings.过水面积 ?? ''
})
const areaLocked = computed(() => areaHint.value !== '')

function openLock(row: DischargeRecord) {
  const source = activeReading(row)
  lockTarget.value = row
  lockForm.value = {
    测量方法: source.测量方法,
    断面流量: source.断面流量,
    最大流速: source.最大流速,
    // 编辑态展示旧值，但提交时领域层仍会强制用最近锁定快照，双保险。
    过水面积: areaHint.value || source.过水面积,
    测量时间: source.测量时间,
  }
  setMessage(true, '')
}

function confirmLock() {
  if (!lockTarget.value || submitting.value) {
    return
  }
  submitting.value = true
  const target = lockTarget.value
  const outcome = submitDischarge({
    id: target.id,
    action: 'lock',
    expectedRev: target.rev,
    operator: operatorName.value || '测量员',
    draft: { ...lockForm.value },
    requestKey: buildRequestKey(target.id, 'lock', target.rev, operatorName.value),
  })
  submitting.value = false
  setMessage(outcome.ok, outcome.message)
  if (outcome.ok) {
    lockTarget.value = null
  }
  reload()
}

function runMarkAbnormal(row: DischargeRecord) {
  if (submitting.value) {
    return
  }
  submitting.value = true
  const outcome = submitDischarge({
    id: row.id,
    action: 'abnormal',
    expectedRev: row.rev,
    operator: operatorName.value || '测量员',
    note: '测量员标记异常',
    requestKey: buildRequestKey(row.id, 'abnormal', row.rev, operatorName.value),
  })
  submitting.value = false
  setMessage(outcome.ok, outcome.message)
  reload()
}

// ---------- 审核员签认 / 退回 ----------

const reviewTarget = ref<DischargeRecord | null>(null)
const reviewNote = ref('')

function openReview(row: DischargeRecord) {
  reviewTarget.value = row
  reviewNote.value = ''
  setMessage(true, '')
}

const reviewVersion = computed<SignoffVersion | null>(() => {
  if (!reviewTarget.value) {
    return null
  }
  return (
    reviewTarget.value.versions.find(
      (item) => item.version === reviewTarget.value?.currentVersion,
    ) ?? null
  )
})

const reviewSnapshot = computed<DischargeReading>(() => reviewVersion.value?.readings ?? {
  测量方法: '',
  断面流量: '',
  最大流速: '',
  过水面积: '',
  测量时间: '',
})

function afterSigned(outcome: ReturnType<typeof submitDischarge>) {
  // 签认成功：成果流入整编页待核对队列。
  if (outcome.ok && outcome.record) {
    upsertSignedCheck(outcome.record.id)
  }
}

function confirmSign() {
  if (!reviewTarget.value || submitting.value) {
    return
  }
  submitting.value = true
  const target = reviewTarget.value
  const outcome = submitDischarge({
    id: target.id,
    action: 'sign',
    expectedRev: target.rev,
    operator: operatorName.value || '审核员',
    note: reviewNote.value,
    requestKey: buildRequestKey(target.id, 'sign', target.rev, operatorName.value),
  })
  submitting.value = false
  afterSigned(outcome)
  setMessage(outcome.ok, outcome.message)
  if (outcome.ok) {
    reviewTarget.value = null
  }
  reload()
}

function confirmReturn() {
  if (!reviewTarget.value || submitting.value) {
    return
  }
  submitting.value = true
  const target = reviewTarget.value
  const outcome = submitDischarge({
    id: target.id,
    action: 'return',
    expectedRev: target.rev,
    operator: operatorName.value || '审核员',
    note: reviewNote.value || '审核员退回修订',
    requestKey: buildRequestKey(target.id, 'return', target.rev, operatorName.value),
  })
  submitting.value = false
  setMessage(outcome.ok, outcome.message)
  if (outcome.ok) {
    reviewTarget.value = null
  }
  reload()
}

// ---------- 版本历史 ----------

const historyTarget = ref<DischargeRecord | null>(null)

function openHistory(row: DischargeRecord) {
  historyTarget.value = rows.value.find((item) => item.id === row.id) ?? row
}

function readingEntries(readings: DischargeReading): [string, string][] {
  return [
    ['测量方法', readings.测量方法],
    ['断面流量 (m³/s)', readings.断面流量],
    ['最大流速 (m/s)', readings.最大流速],
    ['过水面积 (m²)', readings.过水面积],
    ['测量时间', readings.测量时间],
  ]
}

function formatTime(stamp?: string): string {
  if (!stamp) {
    return '—'
  }
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) {
    return stamp
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}

// ---------- 并发 / 连续提交演示 ----------

const demoOpen = ref(false)
const demoBusy = ref(false)
const demoLog = ref<{ text: string; kind: 'ok' | 'fail' | 'info' }[]>([])

const demoRecord = computed(() => rows.value.find((row) => row.stage === '已锁定') ?? null)

function openDemo() {
  reload()
  demoOpen.value = true
  demoLog.value = []
  const target = rows.value.find((row) => row.stage === '已锁定')
  if (!target) {
    demoLog.value.push({
      text: '当前没有「已锁定」记录，可先用测量员身份锁定一条，再打开演示。',
      kind: 'info',
    })
  }
}

function runConcurrentSign() {
  const target = listDischarge().find((row) => row.stage === '已锁定')
  if (!target) {
    demoLog.value.push({ text: '没有已锁定记录可供演示', kind: 'info' })
    return
  }
  demoBusy.value = true
  const rev = target.rev
  demoLog.value.push({
    text: `两名审核员（审核员·王芳 / 审核员·赵磊）同时对 ${target.记录编号} rev=${rev} 发起签认……`,
    kind: 'info',
  })
  const first = submitDischarge({
    id: target.id,
    action: 'sign',
    expectedRev: rev,
    operator: '审核员·王芳',
    note: '并发演示-王芳',
    requestKey: buildRequestKey(target.id, 'sign', rev, '审核员·王芳'),
  })
  const second = submitDischarge({
    id: target.id,
    action: 'sign',
    expectedRev: rev,
    operator: '审核员·赵磊',
    note: '并发演示-赵磊',
    requestKey: buildRequestKey(target.id, 'sign', rev, '审核员·赵磊'),
  })
  demoLog.value.push({ text: `王芳结果：${first.message}`, kind: first.ok ? 'ok' : 'fail' })
  demoLog.value.push({ text: `赵磊结果：${second.message}`, kind: second.ok ? 'ok' : 'fail' })
  if (first.ok) {
    upsertSignedCheck(target.id)
  }
  demoBusy.value = false
  reload()
}

function runDuplicateSubmit() {
  const target = listDischarge().find((row) => row.stage === '已锁定')
  if (!target) {
    demoLog.value.push({ text: '没有已锁定记录可供演示', kind: 'info' })
    return
  }
  demoBusy.value = true
  const rev = target.rev
  const key = buildRequestKey(target.id, 'sign', rev, '审核员·王芳')
  demoLog.value.push({
    text: `王芳对 ${target.记录编号} rev=${rev} 用同一请求键连续签认两次……`,
    kind: 'info',
  })
  const first = submitDischarge({
    id: target.id,
    action: 'sign',
    expectedRev: rev,
    operator: '审核员·王芳',
    requestKey: key,
  })
  const second = submitDischarge({
    id: target.id,
    action: 'sign',
    expectedRev: rev,
    operator: '审核员·王芳',
    requestKey: key,
  })
  demoLog.value.push({ text: `首次提交：${first.message}`, kind: first.ok ? 'ok' : 'fail' })
  demoLog.value.push({
    text: `连续第二次：${second.message}（回放首次结果，未再产生签章）`,
    kind: second.ok ? 'ok' : 'fail',
  })
  if (first.ok) {
    upsertSignedCheck(target.id)
  }
  demoBusy.value = false
  reload()
}

function runSignAfterReturn() {
  const target = listDischarge().find((row) => row.stage === '已锁定')
  if (!target) {
    demoLog.value.push({ text: '没有已锁定记录可供演示', kind: 'info' })
    return
  }
  demoBusy.value = true
  const rev = target.rev
  demoLog.value.push({
    text: `${target.记录编号} rev=${rev}：审核员甲先退回，审核员乙随后再签认……`,
    kind: 'info',
  })
  const returned = submitDischarge({
    id: target.id,
    action: 'return',
    expectedRev: rev,
    operator: '审核员·王芳',
    note: '演示：先行退回',
    requestKey: buildRequestKey(target.id, 'return', rev, '审核员·王芳'),
  })
  const signed = submitDischarge({
    id: target.id,
    action: 'sign',
    expectedRev: rev,
    operator: '审核员·赵磊',
    requestKey: buildRequestKey(target.id, 'sign', rev, '审核员·赵磊'),
  })
  demoLog.value.push({ text: `退回结果：${returned.message}`, kind: returned.ok ? 'ok' : 'fail' })
  demoLog.value.push({
    text: `随后签认：${signed.message}（流转失败，版本与签章均无变化）`,
    kind: signed.ok ? 'ok' : 'fail',
  })
  demoBusy.value = false
  reload()
}

// ---------- 其他 ----------

function exportRows() {
  const { filename, content } = exportDischargeCsv()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function reseed() {
  resetDischarge()
  reload()
  setMessage(true, '已恢复流量签认演示数据')
}

reload()
</script>
