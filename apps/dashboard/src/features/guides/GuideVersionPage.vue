<script setup lang="ts">
import type { GuideVersion, StepPlacement } from '@contextlayer/shared'
import { computed, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'

import ErrorMessage from '../../components/ErrorMessage.vue'
import { describeError } from '../../lib/errors'
import { getApplication } from '../applications/applications-api'
import { useCurrentWorkspace } from '../workspaces/current-workspace'
import * as api from './guides-api'
import RichTextView from './RichTextView'

const route = useRoute()
const workspace = useCurrentWorkspace()
const guideId = computed(() => String(route.params.guideId))
const versionNumber = computed(() => Number(route.params.version))

const version = shallowRef<GuideVersion>()
const applicationName = shallowRef<string>()
const loading = shallowRef(true)
const error = shallowRef<string>()

async function load(workspaceId: string, id: string, number: number) {
  loading.value = true
  error.value = undefined
  try {
    version.value = await api.getVersion(workspaceId, id, number)
    applicationName.value = (
      await getApplication(workspaceId, version.value.snapshot.guide.applicationId)
    ).name
  } catch (cause) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

watch(
  () => [workspace.value?.id, guideId.value, versionNumber.value] as const,
  ([workspaceId, id, number]) => {
    if (workspaceId !== undefined) void load(workspaceId, id, number)
  },
  { immediate: true },
)

const PLACEMENT_LABELS: Record<StepPlacement, string> = {
  auto: 'Automatic',
  top: 'Above the element',
  right: 'Right of the element',
  bottom: 'Below the element',
  left: 'Left of the element',
}
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' })
</script>

<template>
  <div v-if="workspace">
    <nav aria-label="Breadcrumb" class="text-sm text-slate-600">
      <RouterLink
        :to="{ name: 'applications', params: { workspaceId: workspace.id } }"
        class="hover:text-slate-900 hover:underline"
        >Applications</RouterLink
      >
      <template v-if="version">
        <span aria-hidden="true"> / </span>
        <RouterLink
          :to="{
            name: 'application',
            params: {
              workspaceId: workspace.id,
              applicationId: version.snapshot.guide.applicationId,
            },
          }"
          class="hover:text-slate-900 hover:underline"
          >{{ applicationName ?? 'Application' }}</RouterLink
        >
        <span aria-hidden="true"> / </span>
        <RouterLink
          :to="{ name: 'guide', params: { workspaceId: workspace.id, guideId } }"
          class="hover:text-slate-900 hover:underline"
          >{{ version.snapshot.guide.title }}</RouterLink
        >
        <span aria-hidden="true"> / </span>
        <span>Version {{ version.version }}</span>
      </template>
    </nav>

    <ErrorMessage class="mt-6" :message="error" />
    <p v-if="loading && !version" class="mt-6 text-sm text-slate-600">Loading version…</p>

    <article v-if="version" class="mt-3 max-w-3xl" data-testid="version-snapshot">
      <header>
        <p class="text-sm font-medium text-brand-700" data-testid="version-number">
          Version {{ version.version }}
        </p>
        <h1 class="mt-1 text-2xl font-semibold tracking-tight">
          {{ version.snapshot.guide.title }}
        </h1>
        <p v-if="version.snapshot.guide.description" class="mt-2 text-sm text-slate-600">
          {{ version.snapshot.guide.description }}
        </p>
      </header>

      <p
        class="mt-5 rounded-lg border border-slate-200 bg-slate-100 px-3 py-2.5 text-sm text-slate-700"
      >
        Read-only snapshot, published {{ dateFormat.format(new Date(version.publishedAt)) }}
        <template v-if="version.publishedBy"> by {{ version.publishedBy.displayName }}</template
        >. Later changes to the draft never alter it; they become a new version when published.
        <RouterLink
          :to="{ name: 'guide', params: { workspaceId: workspace.id, guideId } }"
          class="ml-1 font-medium text-brand-700 hover:underline"
          >Open the draft</RouterLink
        >
      </p>

      <dl v-if="version.snapshot.guide.startUrlPattern?.pathname" class="mt-5 text-sm">
        <dt class="font-medium text-slate-800">Start page</dt>
        <dd class="mt-0.5 font-mono text-slate-700">
          {{ version.snapshot.guide.startUrlPattern.pathname }}
        </dd>
      </dl>

      <ol class="mt-6 space-y-4" aria-label="Steps">
        <li
          v-for="step in version.snapshot.steps"
          :key="step.id"
          class="rounded-xl border border-slate-200 bg-white p-5"
          data-testid="version-step"
        >
          <div class="flex items-center gap-2">
            <span
              class="grid size-7 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700"
              aria-hidden="true"
              >{{ step.position + 1 }}</span
            >
            <h2 class="text-sm font-semibold text-slate-900">{{ step.title }}</h2>
          </div>
          <RichTextView class="mt-3" :document="step.body" />
          <p class="mt-3 text-xs text-slate-600">
            Popover: {{ PLACEMENT_LABELS[step.placement] }} ·
            {{ step.target ? 'Element captured' : 'No element captured' }}
          </p>
        </li>
      </ol>
    </article>
  </div>
</template>
