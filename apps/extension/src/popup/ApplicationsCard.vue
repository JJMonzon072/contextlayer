<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef } from 'vue'

import { requestApplications } from '../messaging/background-client'
import { CONNECTION_CHANGED, type ApplicationListData } from '../messaging/protocol'

/**
 * The applications of the connected workspace, and on which of their origins
 * ContextLayer runs in this browser. Opening one is how a user gets to the site
 * to turn it on.
 */
const applications = shallowRef<ApplicationListData['applications']>()
const error = shallowRef<string>()

async function load() {
  const result = await requestApplications()
  if (result.ok) {
    applications.value = result.data.applications
    error.value = undefined
  } else {
    error.value = result.error.message
  }
}

function open(origin: string) {
  void chrome.tabs.create({ url: origin })
}

function onMessage(message: unknown, sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return
  if ((message as { type?: unknown } | null)?.type === CONNECTION_CHANGED.type) void load()
}

onMounted(() => {
  chrome.runtime.onMessage.addListener(onMessage)
  void load()
})
onBeforeUnmount(() => {
  chrome.runtime.onMessage.removeListener(onMessage)
})
</script>

<template>
  <section
    v-if="applications !== null"
    aria-labelledby="applications-heading"
    class="mt-3 rounded-xl border border-slate-200 p-3"
    data-testid="applications"
  >
    <h2 id="applications-heading" class="font-medium text-slate-700">Applications</h2>
    <p v-if="error" class="mt-2 text-rose-700" role="alert">{{ error }}</p>
    <p v-else-if="applications === undefined" class="mt-2 text-slate-600">Loading…</p>
    <p v-else-if="applications.length === 0" class="mt-2 text-slate-600">
      No application is registered in this workspace yet.
    </p>
    <ul v-else class="mt-1 divide-y divide-slate-100">
      <li
        v-for="application in applications"
        :key="application.id"
        class="py-1.5"
        data-testid="application"
      >
        <p class="font-medium text-slate-900">{{ application.name }}</p>
        <ul>
          <li
            v-for="site in application.origins"
            :key="site.origin"
            class="flex items-center gap-2 text-xs"
          >
            <button
              type="button"
              class="truncate font-mono text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
              @click="open(site.origin)"
            >
              {{ site.origin }}
            </button>
            <span
              class="ml-auto shrink-0 rounded px-1.5 py-0.5 font-medium"
              :class="site.on ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'"
              data-testid="application-origin-state"
              >{{ site.on ? 'On' : 'Off' }}</span
            >
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>
