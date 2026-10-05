<script setup lang="ts">
import {
  guideDescriptionSchema,
  guideTitleSchema,
  roleAtLeast,
  type Guide,
  type GuideVersionSummary,
  type UrlPattern,
} from '@contextlayer/shared'
import { computed, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import AppButton from '../../components/AppButton.vue'
import ErrorMessage from '../../components/ErrorMessage.vue'
import TextAreaField from '../../components/TextAreaField.vue'
import TextField from '../../components/TextField.vue'
import { describeError } from '../../lib/errors'
import { HttpError } from '../../lib/http'
import { getApplication } from '../applications/applications-api'
import { useCurrentWorkspace } from '../workspaces/current-workspace'
import {
  canAddStep,
  moveStep,
  newStep,
  stepsFingerprint,
  stepsRequest,
  toDraftSteps,
  validateStep,
  type DraftStep,
} from './guide-editor'
import GuideStatusBadge from './GuideStatusBadge.vue'
import * as api from './guides-api'
import StepCard from './StepCard.vue'
import VersionHistory from './VersionHistory.vue'

const route = useRoute()
const router = useRouter()
const workspace = useCurrentWorkspace()
const guideId = computed(() => String(route.params.guideId))
const canAuthor = computed(() =>
  workspace.value ? roleAtLeast(workspace.value.role, 'editor') : false,
)

const guide = shallowRef<Guide>()
const applicationName = shallowRef<string>()
const loading = shallowRef(true)
const loadError = shallowRef<string>()
/** Set when a save was refused because the draft changed elsewhere (409). */
const conflict = shallowRef(false)

// Editable copy of the draft.
const title = shallowRef('')
const description = shallowRef('')
const startPath = shallowRef('')
const steps = ref<DraftStep[]>([])
const savedMeta = shallowRef('')
const savedSteps = shallowRef('')

const readOnly = computed(() => guide.value?.status === 'archived')
/** Patterns other than a plain pathname come from the extension and are kept as they are. */
const startPathEditable = computed(() => {
  const pattern = guide.value?.startUrlPattern
  return pattern === null || pattern === undefined || Object.keys(pattern).join() === 'pathname'
})

function metaFingerprint(): string {
  return JSON.stringify([title.value.trim(), description.value.trim(), startPath.value.trim()])
}

const metaDirty = computed(() => metaFingerprint() !== savedMeta.value)
const stepsDirty = computed(() => stepsFingerprint(steps.value) !== savedSteps.value)
const dirty = computed(() => metaDirty.value || stepsDirty.value)

function apply(next: Guide) {
  guide.value = next
  title.value = next.title
  description.value = next.description
  startPath.value = next.startUrlPattern?.pathname ?? ''
  steps.value = toDraftSteps(next.steps)
  savedMeta.value = metaFingerprint()
  savedSteps.value = stepsFingerprint(steps.value)
}

const versions = shallowRef<GuideVersionSummary[]>([])
const versionsLoading = shallowRef(false)

async function loadVersions(workspaceId: string, id: string) {
  versionsLoading.value = true
  try {
    versions.value = await api.listVersions(workspaceId, id)
  } catch {
    // The history is secondary: the editor stays usable, the list shows what it has.
  } finally {
    versionsLoading.value = false
  }
}

async function load(workspaceId: string, id: string) {
  loading.value = true
  loadError.value = undefined
  conflict.value = false
  try {
    const loaded = await api.getGuide(workspaceId, id)
    apply(loaded)
    void loadVersions(workspaceId, id)
    applicationName.value = (await getApplication(workspaceId, loaded.applicationId)).name
  } catch (cause) {
    loadError.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

watch(
  () => [workspace.value?.id, guideId.value] as const,
  ([workspaceId, id]) => {
    if (workspaceId !== undefined) void load(workspaceId, id)
  },
  { immediate: true },
)

// Steps.
function addStep() {
  if (canAddStep(steps.value)) steps.value = [...steps.value, newStep()]
}

function changeStep(key: string, patch: Partial<DraftStep>) {
  steps.value = steps.value.map((step) => (step.key === key ? { ...step, ...patch } : step))
}

function move(index: number, offset: -1 | 1) {
  steps.value = moveStep(steps.value, index, offset)
}

function removeStep(key: string) {
  steps.value = steps.value.filter((step) => step.key !== key)
}

// Saving.
const saving = shallowRef(false)
const saveError = shallowRef<string>()
const notice = shallowRef<string>()
const showErrors = shallowRef(false)
const titleError = shallowRef<string>()
const descriptionError = shallowRef<string>()
const startPathError = shallowRef<string>()

const stepErrors = computed(() =>
  Object.fromEntries(
    steps.value.map((step) => [step.key, showErrors.value ? validateStep(step) : {}]),
  ),
)

function startPattern(): UrlPattern | null | undefined {
  if (!startPathEditable.value) return undefined
  const path = startPath.value.trim()
  return path === '' ? null : { pathname: path }
}

function validate(): boolean {
  titleError.value = guideTitleSchema.safeParse(title.value).success
    ? undefined
    : 'Use 1 to 120 characters.'
  descriptionError.value = guideDescriptionSchema.safeParse(description.value).success
    ? undefined
    : 'Use at most 500 characters.'
  const path = startPath.value.trim()
  startPathError.value =
    path === '' || (path.startsWith('/') && !/\s/.test(path) && path.length <= 256)
      ? undefined
      : 'Start with “/”, for example /customers. No spaces.'
  showErrors.value = true
  const stepsValid = steps.value.every((step) => Object.keys(validateStep(step)).length === 0)
  return !titleError.value && !descriptionError.value && !startPathError.value && stepsValid
}

async function save() {
  if (!workspace.value || !guide.value || !dirty.value) return
  if (!validate()) {
    saveError.value = 'Fix the highlighted fields before saving.'
    return
  }
  saving.value = true
  saveError.value = undefined
  notice.value = undefined
  const workspaceId = workspace.value.id
  try {
    let current = guide.value
    if (metaDirty.value) {
      const pattern = startPattern()
      current = await api.updateGuide(workspaceId, current.id, {
        title: title.value,
        description: description.value,
        ...(pattern !== undefined && { startUrlPattern: pattern }),
        expectedRevision: current.revision,
      })
    }
    if (stepsDirty.value) {
      current = await api.replaceSteps(
        workspaceId,
        current.id,
        stepsRequest(steps.value, current.revision),
      )
    }
    apply(current)
    showErrors.value = false
    notice.value = 'Draft saved.'
  } catch (cause) {
    conflict.value = cause instanceof HttpError && cause.status === 409
    saveError.value = describeError(cause)
  } finally {
    saving.value = false
  }
}

async function reloadLatest() {
  if (workspace.value) await load(workspace.value.id, guideId.value)
}

// Publishing.
const publishing = shallowRef(false)
const canPublish = computed(
  () => !readOnly.value && !dirty.value && (guide.value?.stepCount ?? 0) > 0,
)
const publishHint = computed(() => {
  if (readOnly.value) return undefined
  if (dirty.value) return 'Save your changes before publishing.'
  if ((guide.value?.stepCount ?? 0) === 0) return 'Add and save at least one step to publish.'
  if (guide.value?.latestVersion !== null && guide.value?.hasUnpublishedChanges === false) {
    return `Version ${String(guide.value.latestVersion)} matches the draft.`
  }
  return undefined
})

async function publish() {
  if (!workspace.value || !guide.value || !canPublish.value) return
  publishing.value = true
  saveError.value = undefined
  notice.value = undefined
  try {
    const result = await api.publishGuide(workspace.value.id, guide.value.id)
    guide.value = { ...guide.value, ...result.guide }
    notice.value = result.created
      ? `Version ${String(result.version.version)} published. It is a read-only snapshot: later edits stay in this draft until you publish again.`
      : `Nothing changed since version ${String(result.version.version)}, so no new version was created.`
    await loadVersions(workspace.value.id, guide.value.id)
  } catch (cause) {
    saveError.value = describeError(cause)
  } finally {
    publishing.value = false
  }
}

// Archive and restore.
const archiving = shallowRef(false)

async function archive() {
  if (!workspace.value || !guide.value) return
  archiving.value = true
  saveError.value = undefined
  try {
    await api.archiveGuide(workspace.value.id, guide.value.id)
    apply(await api.getGuide(workspace.value.id, guide.value.id))
    notice.value = 'Guide archived. Learners no longer see it; its versions are kept.'
  } catch (cause) {
    saveError.value = describeError(cause)
  } finally {
    archiving.value = false
  }
}

async function restore() {
  if (!workspace.value || !guide.value) return
  archiving.value = true
  saveError.value = undefined
  try {
    apply(await api.restoreGuide(workspace.value.id, guide.value.id))
    notice.value = 'Guide restored.'
  } catch (cause) {
    saveError.value = describeError(cause)
  } finally {
    archiving.value = false
  }
}

function backToApplication() {
  if (!workspace.value || !guide.value) return
  void router.push({
    name: 'application',
    params: { workspaceId: workspace.value.id, applicationId: guide.value.applicationId },
  })
}
</script>

<template>
  <div v-if="workspace">
    <nav aria-label="Breadcrumb" class="text-sm text-slate-600">
      <RouterLink
        :to="{ name: 'applications', params: { workspaceId: workspace.id } }"
        class="hover:text-slate-900 hover:underline"
        >Applications</RouterLink
      >
      <template v-if="guide">
        <span aria-hidden="true"> / </span>
        <RouterLink
          :to="{
            name: 'application',
            params: { workspaceId: workspace.id, applicationId: guide.applicationId },
          }"
          class="hover:text-slate-900 hover:underline"
          >{{ applicationName ?? 'Application' }}</RouterLink
        >
        <span aria-hidden="true"> / </span>
        <span>{{ guide.title }}</span>
      </template>
    </nav>

    <p v-if="!canAuthor" class="mt-6 text-sm text-slate-600">
      Guides are prepared by editors. Ask an owner or admin for the editor role.
    </p>
    <ErrorMessage class="mt-6" :message="loadError" />
    <p v-if="loading && !guide" class="mt-6 text-sm text-slate-600">Loading guide…</p>

    <template v-if="guide">
      <p class="sr-only" role="status" aria-live="polite">{{ notice }}</p>
      <header class="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight" data-testid="guide-title">
            {{ guide.title }}
          </h1>
          <div class="mt-2">
            <GuideStatusBadge
              :status="guide.status"
              :latest-version="guide.latestVersion"
              :has-unpublished-changes="guide.hasUnpublishedChanges"
            />
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span v-if="dirty && !readOnly" class="text-sm text-amber-700" data-testid="unsaved"
            >Unsaved changes</span
          >
          <template v-if="!readOnly">
            <AppButton variant="secondary" :disabled="!dirty" :loading="saving" @click="save"
              >Save draft</AppButton
            >
            <AppButton
              :disabled="!canPublish"
              :loading="publishing"
              data-testid="publish"
              @click="publish"
              >Publish</AppButton
            >
            <AppButton variant="danger" :loading="archiving" @click="archive">Archive</AppButton>
          </template>
          <template v-else>
            <AppButton variant="secondary" @click="backToApplication">Back</AppButton>
            <AppButton :loading="archiving" @click="restore">Restore</AppButton>
          </template>
        </div>
      </header>

      <p
        v-if="publishHint"
        class="mt-3 text-right text-xs text-slate-600"
        data-testid="publish-hint"
      >
        {{ publishHint }}
      </p>
      <p
        v-if="readOnly"
        class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
      >
        This guide is archived: learners no longer see it and it cannot be edited. Restore it to
        continue.
      </p>
      <p
        v-if="notice"
        class="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900"
        data-testid="notice"
      >
        {{ notice }}
      </p>
      <ErrorMessage class="mt-4" :message="saveError">
        <template v-if="conflict">
          <button
            type="button"
            class="ml-2 font-medium underline underline-offset-2"
            @click="reloadLatest"
          >
            Reload the latest draft
          </button>
        </template>
      </ErrorMessage>

      <div class="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div class="space-y-8">
          <section
            class="space-y-5 rounded-xl border border-slate-200 bg-white p-6"
            aria-labelledby="details-heading"
          >
            <h2 id="details-heading" class="text-base font-semibold">Details</h2>
            <TextField
              v-model="title"
              label="Title"
              :maxlength="120"
              :error="titleError"
              :readonly="readOnly"
            />
            <TextAreaField
              v-model="description"
              label="Description"
              hint="Optional. What the learner will achieve."
              :rows="2"
              :maxlength="500"
              :error="descriptionError"
              :readonly="readOnly"
            />
            <TextField
              v-if="startPathEditable"
              v-model="startPath"
              label="Start page"
              hint="Optional path where the guide begins, for example /customers. Leave empty for any page."
              :error="startPathError"
              :readonly="readOnly"
            />
          </section>

          <section aria-labelledby="steps-heading">
            <div class="flex items-end justify-between gap-3">
              <div>
                <h2 id="steps-heading" class="text-lg font-semibold">Steps</h2>
                <p class="mt-1 text-sm text-slate-600">
                  The order learners follow. Elements are picked later in the application itself.
                </p>
              </div>
              <AppButton
                v-if="!readOnly"
                variant="secondary"
                :disabled="!canAddStep(steps)"
                @click="addStep"
                >Add step</AppButton
              >
            </div>
            <ol v-if="steps.length > 0" class="mt-4 space-y-4">
              <StepCard
                v-for="(step, index) in steps"
                :key="step.key"
                :step="step"
                :index="index"
                :total="steps.length"
                :errors="stepErrors[step.key] ?? {}"
                :read-only="readOnly"
                @change="changeStep(step.key, $event)"
                @move="move(index, $event)"
                @remove="removeStep(step.key)"
              />
            </ol>
            <p
              v-else
              class="mt-4 rounded-xl border border-dashed border-slate-300 bg-white/60 p-6 text-sm text-slate-600"
            >
              No steps yet. Add the first thing the learner should do.
            </p>
          </section>
        </div>

        <aside class="space-y-6" aria-label="Guide information">
          <VersionHistory
            :workspace-id="workspace.id"
            :guide-id="guide.id"
            :versions="versions"
            :loading="versionsLoading"
          />
          <section class="rounded-xl border border-slate-200 bg-white p-5">
            <h2 class="text-sm font-semibold">Draft</h2>
            <p class="mt-1 text-sm text-slate-600">
              Draft revision {{ guide.revision }} · {{ guide.stepCount }}
              {{ guide.stepCount === 1 ? 'step' : 'steps' }} saved
            </p>
          </section>
        </aside>
      </div>
    </template>
  </div>
</template>
