<script setup lang="ts">
import { roleAtLeast, type Application } from '@contextlayer/shared'
import { computed, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import AppButton from '../../components/AppButton.vue'
import ErrorMessage from '../../components/ErrorMessage.vue'
import { describeError } from '../../lib/errors'
import { useCurrentWorkspace } from '../workspaces/current-workspace'
import * as api from './applications-api'
import ApplicationForm from './ApplicationForm.vue'

const route = useRoute()
const router = useRouter()
const workspace = useCurrentWorkspace()
const applicationId = computed(() => String(route.params.applicationId))
const canManage = computed(() =>
  workspace.value ? roleAtLeast(workspace.value.role, 'admin') : false,
)

const application = shallowRef<Application>()
const loading = shallowRef(true)
const error = shallowRef<string>()
const notice = shallowRef<string>()

async function load(workspaceId: string, id: string) {
  loading.value = true
  error.value = undefined
  try {
    application.value = await api.getApplication(workspaceId, id)
  } catch (cause) {
    application.value = undefined
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

watch(
  () => [workspace.value?.id, applicationId.value] as const,
  ([workspaceId, id]) => {
    if (workspaceId !== undefined) void load(workspaceId, id)
  },
  { immediate: true },
)

const editing = shallowRef(false)
const saving = shallowRef(false)
const formError = shallowRef<string>()

async function save(value: { name: string; origins: string[] }) {
  if (!workspace.value || !application.value) return
  saving.value = true
  formError.value = undefined
  try {
    application.value = await api.updateApplication(workspace.value.id, application.value.id, value)
    editing.value = false
    notice.value = 'Application saved.'
  } catch (cause) {
    formError.value = describeError(cause)
  } finally {
    saving.value = false
  }
}

const confirmingDelete = shallowRef(false)
const deleting = shallowRef(false)
const deleteError = shallowRef<string>()

async function remove() {
  if (!workspace.value || !application.value) return
  deleting.value = true
  deleteError.value = undefined
  try {
    await api.deleteApplication(workspace.value.id, application.value.id)
    await router.replace({ name: 'applications', params: { workspaceId: workspace.value.id } })
  } catch (cause) {
    deleteError.value = describeError(cause)
    confirmingDelete.value = false
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div v-if="workspace">
    <nav aria-label="Breadcrumb" class="text-sm text-slate-600">
      <RouterLink
        :to="{ name: 'applications', params: { workspaceId: workspace.id } }"
        class="hover:text-slate-900 hover:underline"
      >
        Applications
      </RouterLink>
      <span aria-hidden="true"> / </span>
      <span>{{ application?.name ?? 'Application' }}</span>
    </nav>

    <ErrorMessage class="mt-6" :message="error" />
    <p v-if="loading && !application" class="mt-6 text-sm text-slate-600">Loading…</p>

    <template v-if="application">
      <p class="sr-only" role="status" aria-live="polite">{{ notice }}</p>
      <div class="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight" data-testid="application-name">
            {{ application.name }}
          </h1>
          <ul class="mt-2 flex flex-wrap gap-1.5" aria-label="Origins">
            <li
              v-for="origin in application.origins"
              :key="origin"
              class="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700"
              data-testid="application-origin"
            >
              {{ origin }}
            </li>
          </ul>
        </div>
        <div v-if="canManage && !editing" class="flex gap-2">
          <AppButton variant="secondary" @click="editing = true">Edit</AppButton>
          <AppButton v-if="!confirmingDelete" variant="danger" @click="confirmingDelete = true">
            Delete
          </AppButton>
        </div>
      </div>

      <div
        v-if="confirmingDelete"
        class="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
      >
        <p class="flex-1">
          Delete {{ application.name }}? Only applications without guides can be deleted.
        </p>
        <AppButton variant="secondary" @click="confirmingDelete = false">Cancel</AppButton>
        <AppButton variant="danger" :loading="deleting" @click="remove"
          >Delete application</AppButton
        >
      </div>
      <ErrorMessage class="mt-4" :message="deleteError" />

      <section
        v-if="editing"
        class="mt-6 max-w-2xl rounded-xl border border-slate-200 bg-white p-6"
        aria-labelledby="edit-application-heading"
      >
        <h2 id="edit-application-heading" class="text-base font-semibold">Edit application</h2>
        <ApplicationForm
          class="mt-5"
          submit-label="Save application"
          :initial="application"
          :busy="saving"
          :error="formError"
          @submit="save"
          @cancel="editing = false"
        />
      </section>
    </template>
  </div>
</template>
