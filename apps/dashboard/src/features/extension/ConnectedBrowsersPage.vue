<script setup lang="ts">
import type { Connection, ConnectionStatus, GrantRevocationReason } from '@contextlayer/shared'
import { onMounted, shallowRef } from 'vue'

import AppButton from '../../components/AppButton.vue'
import ErrorMessage from '../../components/ErrorMessage.vue'
import { describeError } from '../../lib/errors'
import * as api from './extension-api'

const connections = shallowRef<Connection[]>([])
const loading = shallowRef(true)
const error = shallowRef<string>()
const notice = shallowRef<string>()
const confirmingId = shallowRef<string>()
const revokingId = shallowRef<string>()

async function load() {
  loading.value = true
  error.value = undefined
  try {
    connections.value = await api.listConnections()
  } catch (cause) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function revoke(connection: Connection) {
  revokingId.value = connection.id
  error.value = undefined
  try {
    await api.revokeConnection(connection.id)
    notice.value = `${connection.label} (${connection.workspace.name}) was revoked. Its next request is refused.`
    confirmingId.value = undefined
    await load()
  } catch (cause) {
    error.value = describeError(cause)
  } finally {
    revokingId.value = undefined
  }
}

const STATUS: Record<ConnectionStatus, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  expired: { label: 'Expired', tone: 'bg-slate-100 text-slate-700 ring-slate-200' },
  revoked: { label: 'Revoked', tone: 'bg-rose-50 text-rose-800 ring-rose-200' },
}

const REASONS: Record<GrantRevocationReason, string> = {
  dashboard: 'Revoked from this page.',
  disconnected: 'Disconnected from the extension.',
  replaced: 'Replaced by a newer connection.',
  'refresh-reuse': 'Revoked automatically: a refresh token was used twice.',
  'code-replay': 'Revoked automatically: its connection code was used twice.',
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const formatDate = (value: string | null) => (value ? dateFormat.format(new Date(value)) : '—')
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Connected browsers</h1>
    <p class="mt-1 max-w-2xl text-sm text-slate-600">
      Browsers where you connected the ContextLayer extension to one of your workspaces. Revoking a
      connection signs that extension out at its next request; signing out of the dashboard does
      not.
    </p>

    <p class="sr-only" role="status" aria-live="polite">{{ notice }}</p>
    <p
      v-if="notice"
      class="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900"
      data-testid="notice"
    >
      {{ notice }}
    </p>
    <ErrorMessage class="mt-6" :message="error" />

    <div class="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table class="w-full text-left text-sm" :aria-busy="loading ? 'true' : undefined">
        <caption class="sr-only">
          Your connected browsers
        </caption>
        <thead class="border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase">
          <tr>
            <th scope="col" class="px-5 py-3">Connection</th>
            <th scope="col" class="px-5 py-3">Status</th>
            <th scope="col" class="hidden px-5 py-3 md:table-cell">Connected</th>
            <th scope="col" class="hidden px-5 py-3 md:table-cell">Last used</th>
            <th scope="col" class="px-5 py-3"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-if="loading && connections.length === 0">
            <td colspan="5" class="px-5 py-6 text-slate-600">Loading connections…</td>
          </tr>
          <tr v-else-if="!loading && connections.length === 0">
            <td colspan="5" class="px-5 py-6 text-slate-600">
              No browser is connected. Open the ContextLayer extension and choose “Connect to
              ContextLayer”.
            </td>
          </tr>
          <tr v-for="connection in connections" :key="connection.id" data-testid="connection-row">
            <td class="px-5 py-3">
              <p class="font-medium text-slate-900">{{ connection.label }}</p>
              <p class="text-slate-600">{{ connection.workspace.name }}</p>
            </td>
            <td class="px-5 py-3">
              <span
                class="rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset"
                :class="STATUS[connection.status].tone"
                data-testid="connection-status"
                >{{ STATUS[connection.status].label }}</span
              >
              <p v-if="connection.revokedReason" class="mt-1 text-xs text-slate-600">
                {{ REASONS[connection.revokedReason] }}
              </p>
              <p v-else-if="connection.status === 'active'" class="mt-1 text-xs text-slate-600">
                Until {{ formatDate(connection.expiresAt) }}
              </p>
            </td>
            <td class="hidden px-5 py-3 text-slate-600 md:table-cell">
              {{ formatDate(connection.createdAt) }}
            </td>
            <td class="hidden px-5 py-3 text-slate-600 md:table-cell">
              {{ formatDate(connection.lastUsedAt) }}
            </td>
            <td class="px-5 py-3 text-right whitespace-nowrap">
              <template v-if="connection.status === 'active'">
                <template v-if="confirmingId === connection.id">
                  <AppButton variant="secondary" class="mr-2" @click="confirmingId = undefined">
                    Cancel
                  </AppButton>
                  <AppButton
                    variant="danger"
                    :loading="revokingId === connection.id"
                    @click="revoke(connection)"
                  >
                    Confirm revoke
                  </AppButton>
                </template>
                <AppButton v-else variant="danger" @click="confirmingId = connection.id">
                  Revoke<span class="sr-only">
                    {{ connection.label }} ({{ connection.workspace.name }})</span
                  >
                </AppButton>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
