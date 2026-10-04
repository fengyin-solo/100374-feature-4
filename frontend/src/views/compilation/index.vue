<template>
  <section class="page" data-module="compilation">
    <header class="page-head">
      <div>
        <h2>数据整编管理</h2>
        <p class="page-desc">维护整编成果，围绕成果编号、整编年份、站点编号、整编类型做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记整编成果</button>
        <button class="btn" type="button" @click="exportRows">导出数据整编清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="check-block">
      <header class="check-head">
        <div>
          <h3>待核对成果（流量签认后流入）</h3>
          <p class="page-desc">已签认的流量成果先在此核对：纳入整编即进入整编成果清单；退回重核会在流量侧重开修订轮次，历史签认版本保留。</p>
        </div>
        <div class="check-tabs">
          <button
            v-for="tab in checkTabs"
            :key="tab"
            class="role-chip"
            :class="{ active: checkTab === tab }"
            type="button"
            @click="checkTab = tab"
          >
            {{ tab }}（{{ checkCount(tab) }}）
          </button>
        </div>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>核对编号</th>
            <th>流量记录</th>
            <th>站点编号</th>
            <th>测量方法</th>
            <th>断面流量</th>
            <th>过水面积</th>
            <th>签认版本</th>
            <th>签认人</th>
            <th>签认时间</th>
            <th>核对状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredChecks" :key="item.id">
            <td>{{ item.id }}</td>
            <td>{{ item.记录编号 }}</td>
            <td>{{ item.站点编号 }}</td>
            <td>{{ item.测量方法 }}</td>
            <td>{{ item.断面流量 }}</td>
            <td>{{ item.过水面积 }}</td>
            <td>V{{ item.版本号 }}</td>
            <td>{{ item.签认人 }}</td>
            <td>{{ formatTime(item.签认时间) }}</td>
            <td><span class="stage-badge" :class="checkClass(item.status)">{{ item.status }}</span></td>
            <td class="row-actions">
              <template v-if="item.status === '待核对'">
                <button class="link" type="button" @click="adopt(item)">纳入整编</button>
                <button class="link danger" type="button" @click="reject(item)">退回重核</button>
              </template>
              <span v-else class="muted-text">已处置</span>
            </td>
          </tr>
          <tr v-if="!filteredChecks.length">
            <td colspan="11" class="empty-state">暂无{{ checkTab }}的流量成果，签认通过后会自动流入</td>
          </tr>
        </tbody>
      </table>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

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
          <td :colspan="columns.length + 2" class="empty-state">暂无数据整编数据，可先登记整编成果</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据整编记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  adoptCheck,
  listChecks,
  rejectCheck,
  type CompilationCheck,
  type CheckStatus,
} from '@/data/discharge/compilation-queue'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('compilation')
const columns = ["成果编号", "整编年份", "站点编号", "整编类型", "原始记录数", "整编人", "审核人", "整编状态"]
const actions = ["开始整编", "提交审核", "驳回整编"]
const statuses = ["待整编", "整编中", "待审核", "已刊印", "已驳回"]
const stats = [{"label": "待整编年度", "value": 0}, {"label": "整编中年度", "value": 0}, {"label": "已刊印成果", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 待核对成果：来自流量签认链路
const checks = ref<CompilationCheck[]>([])
const checkTabs: CheckStatus[] = ['待核对', '已纳入', '退回重核']
const checkTab = ref<CheckStatus>('待核对')
const checkOperator = ref('整编员·孙倩')

const filteredChecks = computed(() =>
  checks.value.filter((item) => item.status === checkTab.value),
)

function checkCount(tab: CheckStatus): number {
  return checks.value.filter((item) => item.status === tab).length
}

function checkClass(status: CheckStatus): string {
  return {
    待核对: 'stage-locked',
    已纳入: 'stage-signed',
    退回重核: 'stage-returned',
  }[status]
}

function formatTime(stamp: string): string {
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) {
    return stamp
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}

function adopt(item: CompilationCheck) {
  const result = adoptCheck(item.id)
  errorMessage.value = result.ok ? '' : result.message
  reloadChecks()
}

function reject(item: CompilationCheck) {
  const reason = window.prompt(`退回重核原因（${item.id}）`, '整编核对发现问题，请重新复测签认')
  if (reason === null) {
    return
  }
  const result = rejectCheck(item.id, checkOperator.value, reason || '整编退回重核')
  errorMessage.value = result.ok ? '' : result.message
  reloadChecks()
}

function reloadChecks() {
  checks.value = listChecks()
}

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '整编成果登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据整编列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadChecks()
})
</script>
