<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue'

import {
  cancelConnection,
  disconnect,
  requestConnectionStatus,
  startConnection,
} from '../messaging/background-client'
import { CONNECTION_CHANGED, type ConnectionStatusData } from '../messaging/protocol'

const status = shallowRef<ConnectionStatusData>()
const error = shallowRef<string>()
const notice = shallowRef<string>()
const busy = shallowRef(false)

async function refresh() {
  const result = await requestConnectionStatus()
  if (result.ok) {
    status.value = result.data
    error.value = undefined
  } else {
    error.value = result.error.message
  }
}

async function run(action: () => Promise<{ ok: boolean; error?: { message: string } }>) {
  busy.value = true
  notice.value = undefined
  try {
    const result = await action()
    if (!result.ok) error.value = result.error?.message
    await refresh()
  } finally {
    busy.value = false
  }
}

// Opening the dashboard tab usually closes the popup; the attempt lives in the worker.
const connect = () => run(startConnection)
const cancel = () => run(cancelConnection)

async function leave() {
  await run(async () => {
    const result = await disconnect()
    if (result.ok) {
      notice.value = result.data.serverConfirmed
        ? 'Disconnected. ContextLayer revoked this connection.'
        : 'Disconnected from this browser, but ContextLayer could not be reached to confirm it. You can revoke it from Connected browsers in the dashboard.'
    }
    return result
  })
}

function onMessage(message: unknown, sender: chrome.runtime.MessageSender) {
  // Only the worker announces changes; the message carries no data either way.
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return
  if ((message as { type?: unknown } | null)?.type === CONNECTION_CHANGED.type) void refresh()
}

onMounted(() => {
  chrome.runtime.onMessage.addListener(onMessage)
  void refresh()
})
onBeforeUnmount(() => {
  chrome.runtime.onMessage.removeListener(onMessage)
})

const state = computed(() => status.value?.state ?? 'loading')
</script>

<template>
  <section
    aria-labelledby="connection-heading"
    class="mt-4 rounded-xl border border-slate-200 p-3"
    data-testid="connection"
    :data-state="state"
  >
    <h2 id="connection-heading" class="font-medium text-slate-700">Connection</h2>

    <div aria-live="polite">
      <p v-if="notice" class="mt-2 text-slate-700" data-testid="connection-notice">{{ notice }}</p>
      <p v-if="error" class="mt-2 text-rose-700" role="alert">{{ error }}</p>
    </div>

    <p v-if="state === 'loading'" class="mt-2 text-slate-600">Checking…</p>

    <template v-else-if="status?.state === 'connected' && status.connection">
      <dl class="mt-2 space-y-1 text-slate-700">
        <div class="flex gap-2">
          <dt class="w-20 shrink-0 text-slate-500">Signed in</dt>
          <dd class="min-w-0" data-testid="connection-user">
            <span class="font-medium text-slate-900">{{ status.connection.user.displayName }}</span>
            <span class="block truncate text-xs text-slate-500">{{
              status.connection.user.email
            }}</span>
          </dd>
        </div>
        <div class="flex gap-2">
          <dt class="w-20 shrink-0 text-slate-500">Workspace</dt>
          <dd class="font-medium text-slate-900" data-testid="connection-workspace">
            {{ status.connection.workspace.name }}
          </dd>
        </div>
      </dl>
      <p
        v-if="status.api === 'unreachable'"
        class="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-amber-900"
        data-testid="connection-offline"
      >
        ContextLayer can't be reached right now. This is the last known connection.
      </p>
      <p v-if="status.attemptPending" class="mt-2 text-slate-600">
        Waiting for approval in the dashboard tab…
      </p>
      <div class="mt-3 flex gap-2">
        <button
          v-if="status.attemptPending"
          type="button"
          class="popup-button-secondary"
          :disabled="busy"
          @click="cancel"
        >
          Cancel switch
        </button>
        <button
          v-else
          type="button"
          class="popup-button-secondary"
          :disabled="busy"
          @click="connect"
        >
          Switch workspace
        </button>
        <button type="button" class="popup-button-secondary" :disabled="busy" @click="leave">
          Disconnect
        </button>
      </div>
    </template>

    <template v-else-if="status?.state === 'connecting'">
      <p class="mt-2 text-slate-600">
        Finish in the dashboard tab: sign in, choose a workspace and approve.
      </p>
      <div class="mt-3 flex gap-2">
        <button type="button" class="popup-button-secondary" :disabled="busy" @click="connect">
          Open the dashboard again
        </button>
        <button type="button" class="popup-button-secondary" :disabled="busy" @click="cancel">
          Cancel
        </button>
      </div>
    </template>

    <template v-else>
      <p
        v-if="status?.state === 'ended'"
        class="mt-2 text-amber-900"
        data-testid="connection-ended"
      >
        Your connection expired or was revoked. Connect again to keep using ContextLayer.
      </p>
      <p v-else class="mt-2 text-slate-600">
        Connect this browser to a ContextLayer workspace to see its published guides.
      </p>
      <button type="button" class="popup-button mt-3 w-full" :disabled="busy" @click="connect">
        Connect to ContextLayer
      </button>
    </template>

    <p
      v-if="status && !status.persistent"
      class="mt-2 text-xs text-slate-500"
      data-testid="connection-session-only"
    >
      This browser cannot protect saved credentials, so you will need to connect again after
      restarting it.
    </p>
  </section>
</template>
