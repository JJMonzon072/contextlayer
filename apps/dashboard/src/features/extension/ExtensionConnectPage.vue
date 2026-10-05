<script setup lang="ts">
import {
  CONNECTION_STATE_PATTERN,
  PKCE_CHALLENGE_PATTERN,
  type WorkspaceSummary,
} from '@contextlayer/shared'
import { computed, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import AppButton from '../../components/AppButton.vue'
import ErrorMessage from '../../components/ErrorMessage.vue'
import { describeError } from '../../lib/errors'
import AuthLayout from '../auth/AuthLayout.vue'
import { session } from '../auth/session'
import RoleBadge from '../workspaces/RoleBadge.vue'
import * as api from './extension-api'
import {
  browserLabel,
  externalRuntime,
  sendToExtension,
  type HandoffResult,
} from './extension-bridge'

/**
 * Second half of "Connect to ContextLayer" (ADR 0015). The extension opened this
 * page with its `state` and PKCE challenge; the signed-in user picks a workspace
 * and confirms, the API issues a one-time code, and the code goes straight to
 * the extension. The page never sees a token, and it reports success only once
 * the extension confirms it is connected.
 */
const route = useRoute()
const router = useRouter()

const single = (value: unknown) => (typeof value === 'string' ? value : undefined)
const state = single(route.query.state)
const challenge = single(route.query.challenge)
const validLink =
  state !== undefined &&
  challenge !== undefined &&
  CONNECTION_STATE_PATTERN.test(state) &&
  PKCE_CHALLENGE_PATTERN.test(challenge)

type Phase =
  | { name: 'choose' }
  | { name: 'working' }
  | { name: 'connected'; displayName: string; workspaceName: string; workspaceId: string }
  | { name: 'cancelled' }
  | { name: 'failed'; message: string }

const phase = shallowRef<Phase>({ name: 'choose' })
const extensionPresent = shallowRef(externalRuntime() !== undefined)
const workspaceId = shallowRef<string>()
const error = shallowRef<string>()
const signingOut = shallowRef(false)

const workspaces = session.workspaces
const user = session.user
const chosen = computed<WorkspaceSummary | undefined>(() =>
  workspaces.value.find((workspace) => workspace.id === workspaceId.value),
)

const FAILURES: Record<Exclude<HandoffResult, { ok: true }>['error'], string> = {
  'extension-missing':
    'The ContextLayer extension is not available in this browser any more. Nothing was connected.',
  'no-answer': 'The extension did not answer. Nothing was connected.',
  'invalid-request': 'The extension refused this request. Nothing was connected.',
  'unknown-attempt':
    'The extension is no longer waiting for this connection: it was cancelled, completed or started again. Nothing was connected.',
  'expired-attempt': 'This connection request expired. Nothing was connected.',
  'exchange-failed': 'The extension could not complete the connection. Nothing was connected.',
  'api-unreachable': 'The extension could not reach ContextLayer. Nothing was connected.',
}

async function connect() {
  const workspace = chosen.value
  if (!validLink || workspace === undefined) return
  phase.value = { name: 'working' }
  error.value = undefined

  let code: string
  try {
    ;({ code } = await api.createConnectionCode({
      workspaceId: workspace.id,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      label: browserLabel(),
    }))
  } catch (cause) {
    // No code was issued: the extension is still waiting, so the user can retry.
    error.value = describeError(cause)
    phase.value = { name: 'choose' }
    return
  }

  const answer = await sendToExtension({ type: 'connection.complete', state, code })
  phase.value =
    answer.ok && answer.connection
      ? {
          name: 'connected',
          displayName: answer.connection.user.displayName,
          workspaceName: answer.connection.workspace.name,
          workspaceId: workspace.id,
        }
      : { name: 'failed', message: answer.ok ? FAILURES['no-answer'] : FAILURES[answer.error] }
}

async function cancel() {
  if (validLink) {
    phase.value = { name: 'working' }
    // Best effort: closing the tab cancels the attempt too.
    await sendToExtension({ type: 'connection.cancel', state })
  }
  phase.value = { name: 'cancelled' }
}

async function switchAccount() {
  signingOut.value = true
  try {
    await session.logout()
  } finally {
    signingOut.value = false
    await router.replace({ name: 'login', query: { redirect: route.fullPath } })
  }
}

const title = computed(() =>
  phase.value.name === 'connected' ? 'Extension connected' : 'Connect the extension',
)
</script>

<template>
  <AuthLayout
    :title="title"
    subtitle="Let the ContextLayer extension in this browser show your workspace's published guides."
  >
    <p class="sr-only" role="status" aria-live="polite">
      <template v-if="phase.name === 'working'">Connecting…</template>
      <template v-else-if="phase.name === 'connected'">Extension connected.</template>
    </p>

    <ErrorMessage
      v-if="!validLink"
      message="This connection link is incomplete or invalid. Open the ContextLayer extension and choose “Connect to ContextLayer” again."
      data-testid="invalid-link"
    />

    <div v-else-if="!extensionPresent" class="space-y-4" data-testid="extension-missing">
      <ErrorMessage
        message="The ContextLayer extension is not installed in this browser, or it was built for another dashboard address."
      />
      <AppButton variant="secondary" @click="extensionPresent = externalRuntime() !== undefined">
        Check again
      </AppButton>
    </div>

    <div
      v-else-if="phase.name === 'connected'"
      class="space-y-4 text-sm text-slate-700"
      data-testid="connect-success"
    >
      <p class="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-emerald-900">
        The extension is connected to <strong>{{ phase.workspaceName }}</strong> as
        {{ phase.displayName }}. You can close this tab.
      </p>
      <RouterLink
        :to="{ name: 'connected-browsers', params: { workspaceId: phase.workspaceId } }"
        class="font-medium text-brand-700 underline-offset-2 hover:underline"
      >
        Manage connected browsers
      </RouterLink>
    </div>

    <p
      v-else-if="phase.name === 'cancelled'"
      class="text-sm text-slate-700"
      data-testid="connect-cancelled"
    >
      Connection cancelled. Nothing was shared with the extension. You can close this tab.
    </p>

    <div v-else-if="phase.name === 'failed'" class="space-y-3" data-testid="connect-failed">
      <ErrorMessage :message="phase.message" />
      <p class="text-sm text-slate-600">
        Open the ContextLayer extension and choose “Connect to ContextLayer” to start again.
      </p>
    </div>

    <form v-else class="space-y-6" novalidate @submit.prevent="connect">
      <ErrorMessage :message="error" />

      <div class="rounded-lg border border-slate-200 px-3 py-2.5 text-sm">
        <p class="text-slate-600">Signed in as</p>
        <p class="font-medium text-slate-900" data-testid="connect-account">
          {{ user?.displayName }} <span class="font-normal text-slate-600">{{ user?.email }}</span>
        </p>
        <button
          type="button"
          class="mt-1 font-medium text-brand-700 underline-offset-2 hover:underline disabled:opacity-60"
          :disabled="signingOut || phase.name === 'working'"
          @click="switchAccount"
        >
          Use another account
        </button>
      </div>

      <fieldset v-if="workspaces.length > 0">
        <legend class="text-sm font-medium text-slate-900">Workspace</legend>
        <p class="text-sm text-slate-600">The extension can use one workspace at a time.</p>
        <div class="mt-3 space-y-2">
          <label
            v-for="workspace in workspaces"
            :key="workspace.id"
            class="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 text-sm has-checked:border-brand-600 has-checked:bg-brand-50"
          >
            <input
              v-model="workspaceId"
              type="radio"
              name="workspace"
              :value="workspace.id"
              class="accent-brand-600"
              :disabled="phase.name === 'working'"
            />
            <span class="font-medium text-slate-900">{{ workspace.name }}</span>
            <RoleBadge :role="workspace.role" class="ml-auto" />
          </label>
        </div>
      </fieldset>
      <p v-else class="text-sm text-slate-700">
        You are not a member of any workspace yet.
        <RouterLink
          :to="{ name: 'workspace-new' }"
          class="font-medium text-brand-700 underline-offset-2 hover:underline"
          >Create one</RouterLink
        >, then start again from the extension.
      </p>

      <p v-if="chosen" class="text-sm text-slate-700" data-testid="connect-summary">
        The extension in this browser will be able to read the applications and published guides of
        <strong>{{ chosen.name }}</strong> as {{ user?.displayName }}. It cannot change anything.
        You can revoke it at any time from Connected browsers.
      </p>

      <div class="flex gap-3">
        <AppButton
          type="submit"
          :loading="phase.name === 'working'"
          :disabled="chosen === undefined"
        >
          Connect
        </AppButton>
        <AppButton variant="secondary" :disabled="phase.name === 'working'" @click="cancel">
          Cancel
        </AppButton>
      </div>
    </form>
  </AuthLayout>
</template>
