<script setup lang="ts">
import type { HealthReport } from '@contextlayer/shared'
import { StatusBadge, type StatusTone } from '@contextlayer/ui'
import { computed, onMounted, shallowRef } from 'vue'

import { EXTENSION_VERSION } from '../config'
import { requestApiHealth } from '../messaging/background-client'
import type { MessageResult } from '../messaging/protocol'
import ApplicationsCard from './ApplicationsCard.vue'
import ConnectionCard from './ConnectionCard.vue'
import SiteCard from './SiteCard.vue'

const health = shallowRef<MessageResult<HealthReport>>()

onMounted(async () => {
  health.value = await requestApiHealth()
})

const apiStatus = computed<{ tone: StatusTone; label: string }>(() => {
  if (!health.value) return { tone: 'neutral', label: 'Checking…' }
  if (!health.value.ok) return { tone: 'danger', label: 'Unreachable' }
  return health.value.data.status === 'ok'
    ? { tone: 'success', label: 'Operational' }
    : { tone: 'warning', label: 'Degraded' }
})
</script>

<template>
  <main class="w-80 bg-white p-4 font-sans text-sm text-slate-900">
    <header class="flex items-center gap-2">
      <img src="/icons/icon-32.png" alt="" class="size-6" />
      <h1 class="text-base font-semibold tracking-tight">ContextLayer</h1>
      <span class="ml-auto font-mono text-xs text-slate-500">v{{ EXTENSION_VERSION }}</span>
    </header>

    <ConnectionCard />
    <SiteCard />
    <ApplicationsCard />

    <section aria-labelledby="api-heading" class="mt-3 rounded-xl border border-slate-200 p-3">
      <div class="flex items-center justify-between" aria-live="polite">
        <h2 id="api-heading" class="font-medium text-slate-700">API</h2>
        <span data-testid="api-status">
          <StatusBadge :tone="apiStatus.tone">{{ apiStatus.label }}</StatusBadge>
        </span>
      </div>
    </section>
  </main>
</template>
