<script setup lang="ts">
import { StatusBadge, type StatusTone } from '@contextlayer/ui'
import { computed, onMounted } from 'vue'

import { useApiHealth } from './useApiHealth'

interface StatusView {
  tone: StatusTone
  label: string
}

const { state, refresh } = useApiHealth()

onMounted(() => {
  void refresh()
})

const isLoading = computed(() => state.value.kind === 'loading')
const report = computed(() => (state.value.kind === 'ready' ? state.value.report : undefined))

const apiStatus = computed<StatusView>(() => {
  switch (state.value.kind) {
    case 'loading':
      return { tone: 'neutral', label: 'Checking…' }
    case 'error':
      return { tone: 'danger', label: 'Unreachable' }
    case 'ready':
      return state.value.report.status === 'ok'
        ? { tone: 'success', label: 'Operational' }
        : { tone: 'warning', label: 'Degraded' }
  }
})

const databaseStatus = computed<StatusView>(() => {
  if (!report.value) return { tone: 'neutral', label: 'Unknown' }
  return report.value.checks.database.status === 'up'
    ? { tone: 'success', label: `Up · ${report.value.checks.database.latencyMs} ms` }
    : { tone: 'danger', label: 'Down' }
})
</script>

<template>
  <section
    aria-labelledby="system-status-heading"
    class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
  >
    <div class="flex items-center justify-between gap-4">
      <h2 id="system-status-heading" class="text-base font-semibold text-slate-900">
        System status
      </h2>
      <button
        type="button"
        class="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="isLoading"
        @click="refresh"
      >
        Check again
      </button>
    </div>

    <dl class="mt-5 space-y-3 text-sm" aria-live="polite" :aria-busy="isLoading">
      <div class="flex items-center justify-between">
        <dt class="text-slate-600">API</dt>
        <dd data-testid="api-status">
          <StatusBadge :tone="apiStatus.tone">{{ apiStatus.label }}</StatusBadge>
        </dd>
      </div>
      <div class="flex items-center justify-between">
        <dt class="text-slate-600">Database</dt>
        <dd data-testid="database-status">
          <StatusBadge :tone="databaseStatus.tone">{{ databaseStatus.label }}</StatusBadge>
        </dd>
      </div>
      <div v-if="report" class="flex items-center justify-between">
        <dt class="text-slate-600">API version</dt>
        <dd class="font-mono text-slate-800">{{ report.version }}</dd>
      </div>
    </dl>

    <p
      v-if="state.kind === 'error'"
      role="alert"
      class="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800"
    >
      {{ state.message }}
    </p>
  </section>
</template>
