<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue'

import type { PublishedGuideSummary } from '@contextlayer/shared'

import {
  cancelActivation,
  disableSite,
  requestActivation,
  requestSiteStatus,
  startGuide,
} from '../messaging/background-client'
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

/**
 * "Turn on" (ADR 0017). Both calls happen synchronously in the click's task:
 * 1. the worker is told first, without waiting for its answer, so the request
 *    survives this popup closing while Chrome's prompt is open;
 * 2. Chrome is asked for this one origin while the click's user activation is
 *    still valid (awaiting a message first would spend it: it expires after a
 *    few seconds).
 * The worker turns the site on once Chrome grants it; this popup, if it is
 * still open, only reports the outcome.
 */
function enable() {
  const current = status.value
  const tab = tabId.value
  if (tab === undefined || current === undefined || !('pattern' in current)) return
  busy.value = true
  notice.value = undefined
  const request = requestActivation(tab)
  const permission = chrome.permissions.request({ origins: [current.pattern] }).catch(() => false)
  void report(tab, current.origin, request, permission)
}

async function report(
  tab: number,
  origin: string,
  request: ReturnType<typeof requestActivation>,
  permission: Promise<boolean>,
) {
  try {
    const [requested, granted] = await Promise.all([request, permission])
    if (!granted) {
      if (requested.ok && requested.data.intentId !== null) {
        await cancelActivation(requested.data.intentId)
      }
      notice.value = `Chrome did not allow access to ${origin}. ContextLayer stays off on this site.`
    }
    // Asking for the status lets the worker complete a granted request now.
    apply(await requestSiteStatus(tab))
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

/** Chrome 116+ (`sidePanel.open`) and the `sidePanel` permission. */
const canEdit = typeof (chrome as { sidePanel?: { open?: unknown } }).sidePanel?.open === 'function'

/**
 * Edit Mode (ADR 0018). `sidePanel.open()` needs this click's user gesture, so
 * nothing is awaited before it: the panel is enabled for this tab and opened
 * in the same task (Chrome applies the two calls in order). The page's
 * readiness was checked when the popup loaded (`active`); the panel attaches
 * through the worker, which checks everything again.
 */
function openEditMode() {
  const tab = tabId.value
  if (tab === undefined) return
  notice.value = undefined
  void chrome.sidePanel
    .setOptions({ tabId: tab, path: `sidepanel.html?tab=${String(tab)}`, enabled: true })
    .catch(() => undefined)
  chrome.sidePanel.open({ tabId: tab }).then(
    () => {
      window.close()
    },
    () => {
      notice.value = 'Chrome could not open the Edit Mode panel. Try again.'
    },
  )
}

/**
 * Plays a guide on this tab (Phase 6a). The worker fetches the published
 * version listed here and shows its first step on the page; this popup then
 * closes, so the page has the focus. Anything that stops it is said here.
 */
async function play(guide: PublishedGuideSummary) {
  const tab = tabId.value
  if (tab === undefined) return
  busy.value = true
  notice.value = undefined
  try {
    const started = await startGuide(tab, guide.guideId, guide.version)
    if (started.ok) {
      window.close()
      return
    }
    error.value = started.error.message
    // Published again or unpublished meanwhile: list what is there now.
    if (started.error.code === 'STALE' || started.error.code === 'NOT_FOUND') {
      const latest = await requestSiteStatus(tab)
      if (latest.ok) status.value = latest.data
    }
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
        <li
          v-for="guide in status.guides"
          :key="guide.guideId"
          class="flex items-center gap-2 py-1.5"
          data-testid="guide"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium text-slate-900">{{ guide.title }}</p>
            <p class="text-xs text-slate-500">{{ steps(guide.stepCount) }}</p>
          </div>
          <button
            type="button"
            class="popup-button-secondary shrink-0"
            :aria-label="`Play ${guide.title}`"
            :disabled="busy"
            data-testid="play"
            @click="play(guide)"
          >
            Play
          </button>
        </li>
      </ul>
      <p v-if="status.moreGuides" class="mt-1 text-xs text-slate-500">
        More guides are listed in the dashboard.
      </p>
      <button
        v-if="canEdit"
        type="button"
        class="popup-button mt-3 w-full"
        :disabled="busy"
        data-testid="edit-mode"
        @click="openEditMode"
      >
        Edit Mode
      </button>
      <p v-if="canEdit" class="mt-1 text-xs text-slate-500">
        Create or edit guides for this page in a side panel. Publish them from the dashboard.
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
