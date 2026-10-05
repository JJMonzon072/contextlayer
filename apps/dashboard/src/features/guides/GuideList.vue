<script setup lang="ts">
import { guideTitleSchema, type GuideSummary } from '@contextlayer/shared'
import { shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'

import AppButton from '../../components/AppButton.vue'
import ErrorMessage from '../../components/ErrorMessage.vue'
import TextField from '../../components/TextField.vue'
import { describeError } from '../../lib/errors'
import GuideStatusBadge from './GuideStatusBadge.vue'
import * as api from './guides-api'

const props = defineProps<{ workspaceId: string; applicationId: string }>()

const router = useRouter()
const guides = shallowRef<GuideSummary[]>([])
const nextCursor = shallowRef<string | null>(null)
const showArchived = shallowRef(false)
const loading = shallowRef(true)
const error = shallowRef<string>()

let controller: AbortController | undefined

async function load(cursor?: string) {
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  error.value = undefined
  try {
    const page = await api.listGuides(props.workspaceId, {
      applicationId: props.applicationId,
      ...(showArchived.value && { status: 'archived' as const }),
      cursor,
      signal: current.signal,
    })
    guides.value = cursor ? [...guides.value, ...page.items] : page.items
    nextCursor.value = page.nextCursor
  } catch (cause) {
    if (!current.signal.aborted) error.value = describeError(cause)
  } finally {
    if (!current.signal.aborted) loading.value = false
  }
}

watch(
  () => [props.workspaceId, props.applicationId, showArchived.value],
  () => void load(),
  { immediate: true },
)

const title = shallowRef('')
const titleError = shallowRef<string>()
const creating = shallowRef(false)
const createError = shallowRef<string>()

async function create() {
  const parsed = guideTitleSchema.safeParse(title.value)
  titleError.value = parsed.success ? undefined : 'Use 1 to 120 characters.'
  if (!parsed.success) return
  creating.value = true
  createError.value = undefined
  try {
    const guide = await api.createGuide(props.workspaceId, {
      applicationId: props.applicationId,
      title: parsed.data,
    })
    await router.push({
      name: 'guide',
      params: { workspaceId: props.workspaceId, guideId: guide.id },
    })
  } catch (cause) {
    createError.value = describeError(cause)
  } finally {
    creating.value = false
  }
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
</script>

<template>
  <section aria-labelledby="guides-heading">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 id="guides-heading" class="text-lg font-semibold">Guides</h2>
        <p class="mt-1 text-sm text-slate-600">
          Step-by-step walkthroughs for this application. Learners only ever see published versions.
        </p>
      </div>
      <label class="flex items-center gap-2 text-sm text-slate-700">
        <input v-model="showArchived" type="checkbox" class="size-4 rounded border-slate-300" />
        Show archived guides
      </label>
    </div>

    <form
      class="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-5"
      novalidate
      aria-label="Create a guide"
      @submit.prevent="create"
    >
      <TextField
        v-model="title"
        class="min-w-64 flex-1"
        label="New guide title"
        hint="Name the task it teaches, for example: Create a customer."
        :maxlength="120"
        :error="titleError"
      />
      <AppButton type="submit" :loading="creating">Create guide</AppButton>
    </form>
    <ErrorMessage class="mt-4" :message="createError" />
    <ErrorMessage class="mt-4" :message="error" />

    <div class="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table class="w-full text-left text-sm" :aria-busy="loading ? 'true' : undefined">
        <caption class="sr-only">
          {{
            showArchived ? 'Archived guides' : 'Guides'
          }}
        </caption>
        <thead class="border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase">
          <tr>
            <th scope="col" class="px-5 py-3">Guide</th>
            <th scope="col" class="px-5 py-3">Status</th>
            <th scope="col" class="hidden px-5 py-3 md:table-cell">Steps</th>
            <th scope="col" class="hidden px-5 py-3 md:table-cell">Updated</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-if="!loading && guides.length === 0">
            <td colspan="4" class="px-5 py-6 text-slate-600">
              {{
                showArchived ? 'No archived guides.' : 'No guides yet. Create the first one above.'
              }}
            </td>
          </tr>
          <tr v-for="guide in guides" :key="guide.id" data-testid="guide-row">
            <td class="px-5 py-3">
              <RouterLink
                :to="{ name: 'guide', params: { workspaceId, guideId: guide.id } }"
                class="font-medium text-brand-700 hover:underline"
              >
                {{ guide.title }}
              </RouterLink>
            </td>
            <td class="px-5 py-3">
              <GuideStatusBadge
                :status="guide.status"
                :latest-version="guide.latestVersion"
                :has-unpublished-changes="guide.hasUnpublishedChanges"
              />
            </td>
            <td class="hidden px-5 py-3 text-slate-600 md:table-cell">{{ guide.stepCount }}</td>
            <td class="hidden px-5 py-3 text-slate-600 md:table-cell">
              {{ dateFormat.format(new Date(guide.updatedAt)) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="nextCursor" class="mt-4">
      <AppButton variant="secondary" :loading="loading" @click="load(nextCursor)">
        Load more
      </AppButton>
    </div>
  </section>
</template>
