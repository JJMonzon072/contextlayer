<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue'

import { disableSite, enableSite, requestSiteStatus } from '../messaging/background-client'
import { CONNECTION_CHANGED, type MessageResult, type SiteStatusData } from '../messaging/protocol'
import { activeTabId, pingTab } from './active-tab'

/**
 * The active tab's site (ADR 0017): registered or not in the workspace, turned
 * on or not, Chrome access granted or not, and its published guides.
 */
const tabId = shallowRef<number>()
const status = shallowRef<SiteStatusData>()
const error = shallowRef<string>()
const notice = shallowRef<string>()
const busy = shallowRef(false)

function apply(result: MessageResult<SiteStatusData>) {
  if (result.ok) {
    status.value = result.data
    error.value = undefined
  } else {
    error.value = result.error.message
  }
}

async function load() {
  tabId.value ??= await activeTabId()
  if (tabId.value === undefined) {
    status.value = { state: 'unsupported' }
    return
  }
  apply(await requestSiteStatus(tabId.value))
}

async function enable() {
  const current = status.value
  if (tabId.value === undefined || current === undefined || !('pattern' in current)) return
  busy.value = true
  notice.value = undefined
  try {
    // Requested first, inside the click: Chrome only prompts for a user gesture.
    // An origin the user already granted resolves at once, without a prompt.
    const granted = await chrome.permissions
      .request({ origins: [current.pattern] })
      .catch(() => false)
    if (!granted) {
      notice.value = `Chrome did not allow access to ${current.origin}. ContextLayer stays off on this site.`
      await load()
      return
    }
    apply(await enableSite(tabId.value))
  } finally {
    busy.value = false
  }
}

async function disable() {
  if (tabId.value === undefined) return
  busy.value = true
  notice.value = undefined
  try {
    apply(await disableSite(tabId.value))
    notice.value = 'ContextLayer is off on this site.'
  } finally {
    busy.value = false
  }
}

async function check() {
  if (tabId.value === undefined) return
  const result = await pingTab(tabId.value)
  notice.value = result.ok ? 'Running on this page.' : result.error.message
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

const state = computed(() => status.value?.state ?? 'loading')
const steps = (count: number) => `${String(count)} step${count === 1 ? '' : 's'}`
</script>

<template>
  <section
    v-if="state !== 'disconnected'"
    aria-labelledby="site-heading"
    class="mt-3 rounded-xl border border-slate-200 p-3"
    data-testid="site"
    :data-state="state"
  >
    <h2 id="site-heading" class="font-medium text-slate-700">This site</h2>
    <p
      v-if="status && 'origin' in status"
      class="truncate font-mono text-xs text-slate-500"
      data-testid="site-origin"
    >
      {{ status.origin }}
    </p>

    <div aria-live="polite">
      <p v-if="notice" class="mt-2 text-slate-700" data-testid="site-notice">{{ notice }}</p>
      <p v-if="error" class="mt-2 text-rose-700" role="alert">{{ error }}</p>
    </div>

    <p v-if="state === 'loading'" class="mt-2 text-slate-600">Checking…</p>

    <p v-else-if="status?.state === 'unsupported'" class="mt-2 text-slate-600">
      ContextLayer does not run on this page (browser pages, files and the Chrome Web Store are not
      supported).
    </p>

    <p v-else-if="status?.state === 'api-withheld'" class="mt-2 text-amber-900">
      Chrome is blocking ContextLayer's access to its server. Allow it again in chrome://extensions,
      under ContextLayer → Site access.
    </p>

    <p v-else-if="status?.state === 'api-unreachable'" class="mt-2 text-amber-900">
      ContextLayer can't be reached right now, so this site can't be checked.
    </p>

    <p v-else-if="status?.state === 'not-registered'" class="mt-2 text-slate-600">
      This site is not an application of {{ status.workspace }}. A workspace admin can register it
      in the dashboard.
    </p>

    <template v-else-if="status?.state === 'available'">
      <p class="mt-2 text-slate-600">
        {{ status.applications.join(', ') }} is registered in your workspace. ContextLayer is off on
        this site.
      </p>
      <p v-if="status.permission === 'missing'" class="mt-1 text-xs text-slate-500">
        Chrome will ask you to allow access to this site only.
      </p>
      <button type="button" class="popup-button mt-3 w-full" :disabled="busy" @click="enable">
        Turn on for this site
      </button>
    </template>

    <template v-else-if="status?.state === 'permission-missing'">
      <p class="mt-2 text-amber-900">
        Chrome's access to this site was removed, so ContextLayer is paused here.
      </p>
      <div class="mt-3 flex gap-2">
        <button type="button" class="popup-button" :disabled="busy" @click="enable">
          Allow access
        </button>
        <button type="button" class="popup-button-secondary" :disabled="busy" @click="disable">
          Turn off
        </button>
      </div>
    </template>

    <template v-else-if="status?.state === 'active'">
      <p class="mt-2 text-slate-600">On for {{ status.applications.join(', ') }}.</p>
      <h3 class="mt-3 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        Published guides
      </h3>
      <p v-if="status.guides === null" class="mt-1 text-amber-900" data-testid="guides-error">
        Guides could not be loaded right now.
      </p>
      <p v-else-if="status.guides.length === 0" class="mt-1 text-slate-600" data-testid="no-guides">
        No published guides for this site yet.
      </p>
      <ul v-else class="mt-1 divide-y divide-slate-100" data-testid="guides">
        <li v-for="guide in status.guides" :key="guide.guideId" class="py-1.5" data-testid="guide">
          <p class="font-medium text-slate-900">{{ guide.title }}</p>
          <p class="text-xs text-slate-500">{{ steps(guide.stepCount) }}</p>
        </li>
      </ul>
      <p v-if="status.moreGuides" class="mt-1 text-xs text-slate-500">
        More guides are listed in the dashboard.
      </p>
      <div class="mt-3 flex gap-2">
        <button type="button" class="popup-button-secondary" :disabled="busy" @click="check">
          Check this page
        </button>
        <button type="button" class="popup-button-secondary" :disabled="busy" @click="disable">
          Turn off for this site
        </button>
      </div>
    </template>
  </section>
</template>
