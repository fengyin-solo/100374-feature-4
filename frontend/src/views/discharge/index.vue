<template>
  <section class="page" data-module="discharge">
    <header class="page-head">
      <div>
        <h2>流量监测管理</h2>
        <p class="page-desc">维护流量记录，审核按逐段签认办理：测量员先锁定原始读数，审核员再签认或退回，签认状态只能顺序流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记流量记录</button>
        <button class="btn" type="button" @click="exportRows">导出流量监测清单</button>
      </div>
    </header>

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

    <div class="actor-bar">
      <label class="filter-item">
        <span>当前身份</span>
        <select v-model="actor">
          <option v-for="name in session.actors" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <span class="actor-hint">
        测量员锁定原始读数，审核员签认或退回；两名审核员同时签认同一测段时，只接受先到的有效签章。
      </span>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openPanel(row)">签认详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无流量监测数据，可先登记流量记录</td>
        </tr>
      </tbody>
    </table>

    <section v-if="signoff" class="signoff-panel">
      <header class="signoff-head">
        <h3>逐段签认 — {{ activeRow?.['记录编号'] ?? activeId }}</h3>
        <button class="btn ghost" type="button" @click="closePanel">收起</button>
      </header>

      <div class="signoff-meta">
        <span>测量方法：<strong>{{ signoff.method }}</strong></span>
        <select v-model="methodDraft" class="method-select">
          <option v-for="method in methods" :key="method" :value="method">{{ method }}</option>
        </select>
        <button class="btn" type="button" @click="applyMethod">变更方法</button>
        <span>过水面积：<strong>{{ signoff.area }} ㎡</strong></span>
        <span v-if="signoff.areaPendingCheck" class="badge warn">待核对</span>
        <button
          v-if="signoff.areaPendingCheck && reviewer"
          class="btn"
          type="button"
          @click="applyConfirmArea"
        >
          核对过水面积
        </button>
        <span v-else-if="signoff.areaCheckedBy" class="muted">
          已由 {{ signoff.areaCheckedBy }} 于 {{ signoff.areaCheckedAt }} 核对
        </span>
      </div>
      <p class="muted meta-hint">测量方法变更后，旧过水面积不自动跟随，需核对后才参与整编；历史签认版本仍按签认时的方法与面积留存。</p>

      <table class="data-table">
        <thead>
          <tr>
            <th>测段</th>
            <th>原始读数</th>
            <th>签认状态</th>
            <th>锁定</th>
            <th>签认 / 退回</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="seg in signoff.segments" :key="seg.id">
            <td>{{ seg.name }}</td>
            <td>
              <template v-if="canEditReading(seg)">
                <input v-model="readingDrafts[seg.id]" class="reading-input" />
                <button class="link" type="button" @click="applyReading(seg)">保存读数</button>
              </template>
              <template v-else>{{ seg.reading }}</template>
            </td>
            <td>
              {{ seg.status }}
              <span v-if="seg.returnReason" class="muted">（{{ seg.returnReason }}）</span>
            </td>
            <td>
              <template v-if="seg.lockedBy">{{ seg.lockedBy }} {{ seg.lockedAt }}</template>
              <template v-else>—</template>
            </td>
            <td>
              <template v-if="seg.status === '已签认'">{{ seg.signedBy }} {{ seg.signedAt }}</template>
              <template v-else-if="seg.status === '已退回'">{{ seg.returnedBy }} {{ seg.returnedAt }} 退回</template>
              <template v-else>—</template>
            </td>
            <td class="row-actions">
              <button v-if="canLock(seg)" class="link" type="button" @click="applyLock(seg)">锁定读数</button>
              <button v-if="canSign(seg)" class="link" type="button" @click="applySign(seg)">签认</button>
              <button v-if="canReturn(seg)" class="link" type="button" @click="applyReturn(seg)">退回</button>
              <span v-if="!canLock(seg) && !canSign(seg) && !canReturn(seg)" class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="signoff.history.length" class="signoff-history">
        <h4>历史签认版本</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>版本</th>
              <th>测段</th>
              <th>签认人</th>
              <th>签认时间</th>
              <th>测量方法</th>
              <th>过水面积</th>
              <th>原始读数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in signoff.history" :key="item.version">
              <td>v{{ item.version }}</td>
              <td>{{ item.segmentName }}</td>
              <td>{{ item.signedBy }}</td>
              <td>{{ item.signedAt }}</td>
              <td>{{ item.method }}</td>
              <td>{{ item.area }}</td>
              <td>{{ item.reading }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条流量监测记录</span>
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  DISCHARGE_METHODS,
  changeMethod,
  confirmArea,
  downloadEntries,
  getRecordSignoff,
  isReviewer,
  isSurveyor,
  listEntries,
  lockSegment,
  moduleMeta,
  returnSegment,
  runAction as applyAction,
  signSegment,
  updateReading,
} from '@/api/local-service'
import type { ActionResult, EntryRow, RecordSignoff, SignoffSegment } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('discharge')
const columns = ["记录编号", "站点编号", "测量方法", "断面流量", "最大流速", "过水面积", "测量时间", "记录状态"]
const actions = ["标记异常"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]
const stats = [{"label": "今日测量次数", "value": 0}, {"label": "待审核记录", "value": 0}, {"label": "异常记录数", "value": 0}]
const methods = DISCHARGE_METHODS

const session = useSessionStore()
const actor = computed({
  get: () => session.actor,
  set: (name: string) => session.setActor(name),
})
const surveyor = computed(() => isSurveyor(actor.value))
const reviewer = computed(() => isReviewer(actor.value))

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const activeId = ref<number | null>(null)
const signoff = ref<RecordSignoff | null>(null)
const methodDraft = ref('')
const readingDrafts = ref<Record<string, string>>({})
// 幂等键：面板打开期间同一测段同一动作复用同一个 requestId，连续提交只认首次结果。
const requestIds = new Map<string, string>()

const activeRow = computed(() =>
  rows.value.find((row) => Number(row.id) === activeId.value),
)

function requestId(key: string): string {
  let id = requestIds.get(key)
  if (!id) {
    id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`
    requestIds.set(key, id)
  }
  return id
}

function canLock(seg: SignoffSegment): boolean {
  return surveyor.value && (seg.status === '待锁定' || seg.status === '已退回')
}

function canSign(seg: SignoffSegment): boolean {
  return reviewer.value && seg.status === '已锁定'
}

function canReturn(seg: SignoffSegment): boolean {
  return reviewer.value && seg.status === '已锁定'
}

function canEditReading(seg: SignoffSegment): boolean {
  return surveyor.value && (seg.status === '待锁定' || seg.status === '已退回')
}

function openPanel(row: EntryRow) {
  activeId.value = Number(row.id)
  requestIds.clear()
  refreshSignoff()
}

function closePanel() {
  activeId.value = null
  signoff.value = null
}

function refreshSignoff() {
  if (activeId.value === null) {
    return
  }
  signoff.value = getRecordSignoff(activeId.value)
  methodDraft.value = signoff.value?.method ?? ''
  const drafts: Record<string, string> = {}
  for (const seg of signoff.value?.segments ?? []) {
    drafts[seg.id] = seg.reading
  }
  readingDrafts.value = drafts
}

function handle(result: ActionResult) {
  refreshSignoff()
  reload()
  if (result.ok) {
    okMessage.value = result.message
  } else {
    errorMessage.value = result.message
  }
}

function applyLock(seg: SignoffSegment) {
  if (activeId.value === null) return
  handle(
    lockSegment({
      recordId: activeId.value,
      segmentId: seg.id,
      actor: actor.value,
      requestId: requestId(`${seg.id}:lock`),
      expectedVersion: seg.version,
    }),
  )
}

function applySign(seg: SignoffSegment) {
  if (activeId.value === null) return
  handle(
    signSegment({
      recordId: activeId.value,
      segmentId: seg.id,
      actor: actor.value,
      requestId: requestId(`${seg.id}:sign`),
      expectedVersion: seg.version,
    }),
  )
}

function applyReturn(seg: SignoffSegment) {
  if (activeId.value === null) return
  const reason = window.prompt(`退回测段「${seg.name}」的理由`, '')
  if (reason === null) return
  handle(
    returnSegment({
      recordId: activeId.value,
      segmentId: seg.id,
      actor: actor.value,
      requestId: requestId(`${seg.id}:return`),
      expectedVersion: seg.version,
      reason,
    }),
  )
}

function applyReading(seg: SignoffSegment) {
  if (activeId.value === null) return
  handle(updateReading(activeId.value, seg.id, readingDrafts.value[seg.id] ?? '', actor.value))
}

function applyMethod() {
  if (activeId.value === null) return
  handle(changeMethod(activeId.value, methodDraft.value, actor.value))
}

function applyConfirmArea() {
  if (activeId.value === null || !signoff.value) return
  const input = window.prompt('确认过水面积（㎡），可直接修改', signoff.value.area)
  if (input === null) return
  handle(confirmArea(activeId.value, actor.value, input))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '流量记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  refreshSignoff()
  reload()
}

function reload() {
  errorMessage.value = ''
  okMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '流量监测列表读取失败'
  }
}

onMounted(reload)
</script>
