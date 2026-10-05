<script setup lang="ts">
import { roleAtLeast, type Application } from '@contextlayer/shared'
import { computed, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'

import AppButton from '../../components/AppButton.vue'
import ErrorMessage from '../../components/ErrorMessage.vue'
import { describeError } from '../../lib/errors'
import { useCurrentWorkspace } from '../workspaces/current-workspace'
import * as api from './applications-api'
import ApplicationForm from './ApplicationForm.vue'

const router = useRouter()
const workspace = useCurrentWorkspace()
const canManage = computed(() =>
  workspace.value ? roleAtLeast(workspace.value.role, 'admin') : false,
)

const applications = shallowRef<Application[]>([])
const nextCursor = shallowRef<string | null>(null)
const loading = shallowRef(true)
const error = shallowRef<string>()

const creating = shallowRef(false)
const saving = shallowRef(false)
const formError = shallowRef<string>()

let controller: AbortController | undefined

async function load(workspaceId: string, cursor?: string) {
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  error.value = undefined
  try {
    const page = await api.listApplications(workspaceId, { cursor, signal: current.signal })
    applications.value = cursor ? [...applications.value, ...page.items] : page.items
    nextCursor.value = page.nextCursor
  } catch (cause) {
    if (!current.signal.aborted) error.value = describeError(cause)
  } finally {
    if (!current.signal.aborted) loading.value = false
  }
}

watch(
  () => workspace.value?.id,
  (id) => {
    if (id !== undefined) void load(id)
  },
  { immediate: true },
)

async function create(value: { name: string; origins: string[] }) {
  if (!workspace.value) return
  saving.value = true
  formError.value = undefined
  try {
    const application = await api.createApplication(workspace.value.id, value)
    await router.push({
      name: 'application',
      params: { workspaceId: workspace.value.id, applicationId: application.id },
    })
  } catch (cause) {
    formError.value = describeError(cause)
  } finally {
    saving.value = false
  }
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
</script>

<template>
  <div v-if="workspace">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="max-w-2xl">
        <h1 class="text-2xl font-semibold tracking-tight">Applications</h1>
        <p class="mt-1 text-sm text-slate-600">
          The web applications your team learns to use. Every guide belongs to one of them, and
          ContextLayer only runs on the origins listed here.
        </p>
      </div>
      <AppButton v-if="canManage && !creating" @click="creating = true">
        Register application
      </AppButton>
    </div>

    <section
      v-if="creating"
      class="mt-8 max-w-2xl rounded-xl border border-slate-200 bg-white p-6"
      aria-labelledby="new-application-heading"
    >
      <h2 id="new-application-heading" class="text-base font-semibold">Register an application</h2>
      <p class="mt-1 text-sm text-slate-600">
        Name the software and list where it is served from. You can change both later.
      </p>
      <ApplicationForm
        class="mt-5"
        submit-label="Register application"
        :busy="saving"
        :error="formError"
        @submit="create"
        @cancel="creating = false"
      />
    </section>

    <ErrorMessage class="mt-6" :message="error" />

    <ul
      v-if="applications.length > 0"
      class="mt-8 grid gap-4 md:grid-cols-2"
      aria-label="Applications"
    >
      <li v-for="application in applications" :key="application.id">
        <RouterLink
          :to="{
            name: 'application',
            params: { workspaceId: workspace.id, applicationId: application.id },
          }"
          class="block h-full rounded-xl border border-slate-200 bg-white p-5 transition-colors hover:border-brand-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          data-testid="application-card"
        >
          <p class="font-semibold text-slate-900">{{ application.name }}</p>
          <ul class="mt-2 flex flex-wrap gap-1.5" :aria-label="`Origins of ${application.name}`">
            <li
              v-for="origin in application.origins"
              :key="origin"
              class="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700"
            >
              {{ origin }}
            </li>
          </ul>
          <p class="mt-3 text-xs text-slate-600">
            Registered {{ dateFormat.format(new Date(application.createdAt)) }}
          </p>
        </RouterLink>
      </li>
    </ul>

    <p v-else-if="loading" class="mt-8 text-sm text-slate-600">Loading applications…</p>

    <div
      v-else-if="!error"
      class="mt-8 max-w-2xl rounded-xl border border-dashed border-slate-300 bg-white/60 p-6"
    >
      <p class="font-medium">No applications yet.</p>
      <p class="mt-1 text-sm text-slate-600">
        {{
          canManage
            ? 'Register the first web application your team uses, such as your CRM, to start writing guides for it.'
            : 'An admin of this workspace registers the applications your team uses.'
        }}
      </p>
    </div>

    <div v-if="nextCursor" class="mt-6">
      <AppButton variant="secondary" :loading="loading" @click="load(workspace.id, nextCursor)">
        Load more
      </AppButton>
    </div>
  </div>
</template>
