<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef } from 'vue'

import { DASHBOARD_ORIGIN } from '../config'
import { AUTHORING_CHANGED, CONNECTION_CHANGED } from '../messaging/protocol'
import { chromeAuthoringClient } from './client'
import { createEditMode, type EndReason } from './edit-mode'
import TargetSection from './TargetSection.vue'

/**
 * Edit Mode's side panel (Phase 5): pick a guide of the page's application,
 * edit its steps, point each one at an element of the page and save the
 * draft. Every text field lives here, never in the page; publishing stays in
 * the dashboard.
 */
const tabParam = new URLSearchParams(location.search).get('tab')
const tabId = tabParam !== null && /^\d+$/.test(tabParam) ? Number(tabParam) : undefined
const editMode = createEditMode({ client: chromeAuthoringClient, tabId })
const { state, dirty, problems } = editMode

const newTitle = shallowRef('')
/** An action waiting for the author's confirmation, shown inline. */
const confirming = shallowRef<
  'change-guide' | 'exit' | 'load-latest' | { removeStep: string } | null
>(null)

const ENDED: Record<EndReason, string> = {
  disconnected: 'ContextLayer was disconnected, so Edit Mode ended.',
  'connection-changed': 'Another account or workspace was connected, so Edit Mode ended.',
  'site-off': 'ContextLayer was turned off for this site, or Chrome no longer allows it here.',
  'tab-closed': 'The tab Edit Mode was opened for was closed.',
  moved: 'Edit Mode was opened again in another panel.',
  exited: 'You left Edit Mode.',
  closed: 'Edit Mode ended.',
}

const application = computed(() =>
  state.info?.applications.find((candidate) => candidate.id === state.applicationId),
)
const dashboardLink = computed(() =>
  state.info && state.guide
    ? `${DASHBOARD_ORIGIN}/workspaces/${state.info.workspace.id}/guides/${state.guide.id}`
    : undefined,
)
const busy = computed(() => state.loading || state.saving)
const LOCAL: Record<typeof state.local, string> = {
  none: 'Unsaved changes in this panel.',
  kept: 'Unsaved changes are kept in this browser session until you save. They are lost when the browser closes.',
  'too-large': 'Unsaved changes are too large to keep in this browser session. Save to keep them.',
  quota: 'Unsaved changes could not be kept in this browser session. Save to keep them.',
  failed: 'Unsaved changes could not be kept in this browser session. Save to keep them.',
}

const saveLine = computed(() => {
  if (state.saving) return 'Saving…'
  if (dirty.value) return LOCAL[state.local]
  if (state.lastSavedAt !== null && state.guide) {
    const time = new Date(state.lastSavedAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
    return `Saved to ContextLayer at ${time}.`
  }
  return 'No changes.'
})

function guideState(guide: { status: string; hasUnpublishedChanges: boolean }) {
  if (guide.status === 'draft') return 'Draft, never published'
  return guide.hasUnpublishedChanges ? 'Published, with unpublished changes' : 'Published'
}

async function addStep() {
  const key = editMode.addStep()
  await nextTick()
  document.getElementById(`title-${key}`)?.focus()
}

async function create() {
  if (newTitle.value.trim() === '') return
  await editMode.createGuide(newTitle.value)
  newTitle.value = ''
}

async function changeGuide() {
  confirming.value = null
  await editMode.closeGuide()
}

async function removeStep(key: string) {
  confirming.value = null
  await editMode.removeStep(key)
}

function onMessage(message: unknown, sender: chrome.runtime.MessageSender) {
  // Content scripts can message extension pages too; these carry no data anyway.
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return
  const type = (message as { type?: unknown } | null)?.type
  if (type === AUTHORING_CHANGED.type || type === CONNECTION_CHANGED.type) void editMode.refresh()
}

function onPageHide() {
  editMode.flushLocal()
  editMode.detach()
}

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

async function loadLatest() {
  confirming.value = null
  await editMode.loadLatest()
}

onMounted(() => {
  chrome.runtime.onMessage.addListener(onMessage)
  window.addEventListener('pagehide', onPageHide)
  void editMode.attach()
})
onBeforeUnmount(() => {
  chrome.runtime.onMessage.removeListener(onMessage)
  window.removeEventListener('pagehide', onPageHide)
})
</script>

<template>
  <main class="min-h-screen bg-white font-sans text-sm text-slate-900" data-testid="panel">
    <header class="border-b border-slate-200 px-4 py-3">
      <div class="flex items-center gap-2">
        <img src="/icons/icon-32.png" alt="" class="size-5" />
        <h1 class="text-base font-semibold tracking-tight">Edit Mode</h1>
        <button
          v-if="state.phase === 'ready'"
          type="button"
          class="btn-secondary ml-auto"
          data-testid="exit"
          @click="dirty ? (confirming = 'exit') : editMode.exit()"
        >
          Exit
        </button>
      </div>
      <p v-if="state.info" class="mt-1 text-xs text-slate-600" data-testid="session">
        {{ state.info.workspace.name }} ·
        <span class="font-mono">{{ state.info.origin }}</span>
        <template v-if="application"> · {{ application.name }}</template>
      </p>
      <div
        v-if="confirming === 'exit'"
        class="mt-2 rounded-lg bg-amber-50 p-2 text-amber-950"
        role="alertdialog"
        aria-labelledby="exit-question"
      >
        <p id="exit-question">Leave Edit Mode? Your unsaved changes are not saved.</p>
        <div class="mt-2 flex gap-2">
          <button type="button" class="btn-danger" @click="editMode.exit()">Leave</button>
          <button type="button" class="btn-secondary" @click="confirming = null">Stay</button>
        </div>
      </div>
    </header>

    <p class="sr-only" role="status" aria-live="polite" data-testid="status">{{ state.status }}</p>

    <section v-if="state.phase === 'attaching'" class="px-4 py-6 text-slate-600">
      Connecting to this page…
    </section>

    <section v-else-if="state.phase === 'unavailable'" class="px-4 py-6" data-testid="unavailable">
      <h2 class="font-medium text-slate-800">Edit Mode is not available here</h2>
      <p class="mt-1 text-slate-600">{{ state.unavailable }}</p>
    </section>

    <section v-else-if="state.phase === 'ended'" class="px-4 py-6" data-testid="ended">
      <h2 class="font-medium text-slate-800">Edit Mode ended</h2>
      <p class="mt-1 text-slate-600">{{ ENDED[state.endedReason ?? 'closed'] }}</p>
      <p class="mt-2 text-slate-600">Open it again from the ContextLayer popup on this page.</p>
    </section>

    <template v-else>
      <div
        v-if="state.paused"
        class="mx-4 mt-3 rounded-lg bg-amber-50 p-3 text-amber-950"
        data-testid="paused"
      >
        <p>
          {{
            state.paused === 'navigated'
              ? 'This page was reloaded or changed.'
              : 'The page stopped answering.'
          }}
          Selecting elements is paused.
        </p>
        <button type="button" class="btn mt-2" @click="editMode.resume()">
          Continue on this page
        </button>
      </div>

      <p v-if="state.error" class="mx-4 mt-3 text-rose-700" role="alert" data-testid="error">
        {{ state.error }}
      </p>

      <!-- Several applications share this origin: the author says which one this is. -->
      <section
        v-if="!state.applicationId && state.info"
        class="px-4 py-3"
        aria-labelledby="application-heading"
      >
        <h2 id="application-heading" class="font-medium text-slate-800">
          Which application is this page?
        </h2>
        <ul class="mt-2 space-y-1">
          <li v-for="candidate in state.info.applications" :key="candidate.id">
            <button
              type="button"
              class="btn-secondary w-full text-left"
              @click="editMode.chooseApplication(candidate.id)"
            >
              {{ candidate.name }}
            </button>
          </li>
        </ul>
      </section>

      <section
        v-else-if="!state.guide"
        class="px-4 py-3"
        aria-labelledby="guides-heading"
        data-testid="guide-chooser"
      >
        <h2 id="guides-heading" class="font-medium text-slate-800">Guides</h2>
        <p v-if="state.guidesError" class="mt-1 text-rose-700" role="alert">
          {{ state.guidesError }}
        </p>
        <p v-else-if="state.guides === null" class="mt-1 text-slate-600">Loading guides…</p>
        <p v-else-if="state.guides.length === 0" class="mt-1 text-slate-600">
          No guides for this application yet.
        </p>
        <ul v-else class="mt-2 space-y-1" data-testid="guide-list">
          <li v-for="guide in state.guides" :key="guide.id">
            <button
              type="button"
              class="w-full rounded-lg border border-slate-200 px-3 py-2 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600"
              :disabled="busy"
              @click="editMode.openGuide(guide.id)"
            >
              <span class="block font-medium text-slate-900">{{ guide.title }}</span>
              <span class="block text-xs text-slate-500">
                {{ guideState(guide) }} · {{ guide.stepCount }} step{{
                  guide.stepCount === 1 ? '' : 's'
                }}
              </span>
            </button>
          </li>
        </ul>

        <form class="mt-4" @submit.prevent="create">
          <label for="new-guide" class="block font-medium text-slate-800">New guide</label>
          <div class="mt-1 flex gap-2">
            <input
              id="new-guide"
              v-model="newTitle"
              type="text"
              maxlength="120"
              required
              placeholder="e.g. Create a customer"
              class="field min-w-0 flex-1"
            />
            <button type="submit" class="btn" :disabled="busy || newTitle.trim() === ''">
              Create
            </button>
          </div>
        </form>
      </section>

      <template v-else>
        <section class="px-4 py-3" aria-labelledby="guide-heading" data-testid="guide">
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <h2 id="guide-heading" class="font-semibold break-words text-slate-900">
                {{ state.guide.title }}
              </h2>
              <p class="text-xs text-slate-500">
                {{ guideState(state.guide) }} · revision {{ state.guide.revision }}
              </p>
            </div>
            <button
              type="button"
              class="btn-secondary shrink-0"
              :disabled="busy"
              @click="dirty ? (confirming = 'change-guide') : changeGuide()"
            >
              Change guide
            </button>
          </div>
          <div
            v-if="confirming === 'change-guide'"
            class="mt-2 rounded-lg bg-amber-50 p-2 text-amber-950"
            role="alertdialog"
            aria-labelledby="change-question"
          >
            <p id="change-question">Discard your unsaved changes to this guide?</p>
            <div class="mt-2 flex gap-2">
              <button type="button" class="btn-danger" @click="changeGuide">Discard</button>
              <button type="button" class="btn-secondary" @click="confirming = null">Keep</button>
            </div>
          </div>
          <div
            v-if="state.recovery"
            class="mt-2 rounded-lg bg-sky-50 p-2 text-sky-950"
            data-testid="recovery"
          >
            <p>
              Unsaved changes from {{ time(state.recovery.savedAt) }} were kept in this browser
              session.
              <template v-if="state.recovery.baseRevision !== state.guide.revision">
                The guide was saved elsewhere since then, so restoring them leads to a conflict you
                will have to resolve.
              </template>
            </p>
            <div class="mt-2 flex gap-2">
              <button type="button" class="btn" @click="editMode.restoreLocal()">
                Restore them
              </button>
              <button type="button" class="btn-secondary" @click="editMode.discardLocal()">
                Discard them
              </button>
            </div>
          </div>
          <p v-if="dashboardLink" class="mt-2 text-xs text-slate-600">
            Publishing happens in the dashboard:
            <a :href="dashboardLink" target="_blank" rel="noopener" class="text-brand-700 underline"
              >open this guide there</a
            >.
          </p>
        </section>

        <section class="px-4" aria-labelledby="steps-heading">
          <h2 id="steps-heading" class="sr-only">Steps</h2>
          <p v-if="state.steps.length === 0" class="py-2 text-slate-600">
            No steps yet. Add one, then select the element it points at.
          </p>
          <ol class="space-y-3" data-testid="steps">
            <li
              v-for="(item, index) in state.steps"
              :key="item.key"
              class="rounded-xl border border-slate-200 p-3"
              data-testid="step"
            >
              <div class="flex items-center gap-1">
                <h3 class="font-medium text-slate-800">Step {{ index + 1 }}</h3>
                <span v-if="item.id === null" class="text-xs text-slate-500">(new)</span>
                <div class="ml-auto flex gap-1">
                  <button
                    type="button"
                    class="btn-icon"
                    :disabled="index === 0"
                    :aria-label="`Move step ${index + 1} up`"
                    @click="editMode.moveStep(item.key, -1)"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    class="btn-icon"
                    :disabled="index === state.steps.length - 1"
                    :aria-label="`Move step ${index + 1} down`"
                    @click="editMode.moveStep(item.key, 1)"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    class="btn-icon"
                    :aria-label="`Delete step ${index + 1}`"
                    @click="confirming = { removeStep: item.key }"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div
                v-if="
                  confirming !== null &&
                  typeof confirming === 'object' &&
                  confirming.removeStep === item.key
                "
                class="mt-2 rounded-lg bg-amber-50 p-2 text-amber-950"
                role="alertdialog"
                :aria-labelledby="`remove-question-${item.key}`"
              >
                <p :id="`remove-question-${item.key}`">Delete step {{ index + 1 }}?</p>
                <div class="mt-2 flex gap-2">
                  <button type="button" class="btn-danger" @click="removeStep(item.key)">
                    Delete
                  </button>
                  <button type="button" class="btn-secondary" @click="confirming = null">
                    Keep
                  </button>
                </div>
              </div>

              <label
                :for="`title-${item.key}`"
                class="mt-2 block text-xs font-medium text-slate-700"
                >Title</label
              >
              <input
                :id="`title-${item.key}`"
                type="text"
                maxlength="120"
                class="field mt-1 w-full"
                :value="item.title"
                :aria-invalid="state.showProblems && problems.has(item.key)"
                :aria-describedby="
                  state.showProblems && problems.has(item.key) ? `problem-${item.key}` : undefined
                "
                @input="editMode.setTitle(item.key, ($event.target as HTMLInputElement).value)"
              />
              <p
                v-if="state.showProblems && problems.has(item.key)"
                :id="`problem-${item.key}`"
                class="mt-1 text-xs text-rose-700"
              >
                {{ problems.get(item.key) }}
              </p>

              <template v-if="item.instructions !== null">
                <label
                  :for="`instructions-${item.key}`"
                  class="mt-2 block text-xs font-medium text-slate-700"
                  >Instructions</label
                >
                <textarea
                  :id="`instructions-${item.key}`"
                  rows="3"
                  class="field mt-1 w-full"
                  :value="item.instructions"
                  :aria-describedby="`instructions-help-${item.key}`"
                  @input="
                    editMode.setInstructions(item.key, ($event.target as HTMLTextAreaElement).value)
                  "
                ></textarea>
                <p :id="`instructions-help-${item.key}`" class="text-xs text-slate-500">
                  A blank line starts a new paragraph; lines starting with “- ” make a list.
                </p>
              </template>
              <p v-else class="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-700">
                These instructions use formatting Edit Mode cannot edit. They are kept as they are;
                change them in the dashboard.
              </p>

              <TargetSection
                :step-number="index + 1"
                :target="item.target"
                :capturing="state.capture?.stepKey === item.key"
                :review="state.review?.stepKey === item.key ? state.review.descriptor : null"
                :note="state.captureNote?.stepKey === item.key ? state.captureNote.text : null"
                :disabled="busy || state.paused !== null"
                @select="editMode.startCapture(item.key)"
                @cancel="editMode.cancelCapture()"
                @accept="editMode.acceptReview()"
                @discard="editMode.discardReview()"
                @remove="editMode.removeTarget(item.key)"
              />
            </li>
          </ol>
          <button type="button" class="btn-secondary mt-3 w-full" :disabled="busy" @click="addStep">
            Add step
          </button>
        </section>

        <footer
          class="sticky bottom-0 mt-4 border-t border-slate-200 bg-white px-4 py-3"
          aria-labelledby="save-heading"
        >
          <h2 id="save-heading" class="sr-only">Save</h2>
          <p class="text-slate-700" data-testid="save-state">{{ saveLine }}</p>
          <div v-if="state.conflict" class="mt-1 text-amber-900" data-testid="conflict">
            <p>
              This guide was changed somewhere else since your changes started. They are still here,
              not saved. Saving them would overwrite the other changes, so it is refused.
            </p>
            <button
              v-if="confirming !== 'load-latest'"
              type="button"
              class="btn-secondary mt-2"
              @click="confirming = 'load-latest'"
            >
              Load the latest version
            </button>
            <div
              v-else
              class="mt-2 rounded-lg bg-amber-50 p-2"
              role="alertdialog"
              aria-labelledby="latest-question"
            >
              <p id="latest-question">
                Replace your unsaved changes with the latest version from ContextLayer?
              </p>
              <div class="mt-2 flex gap-2">
                <button type="button" class="btn-danger" @click="loadLatest">Replace</button>
                <button type="button" class="btn-secondary" @click="confirming = null">
                  Keep my changes
                </button>
              </div>
            </div>
          </div>
          <div v-if="state.unknownSave" class="mt-1 text-amber-900" data-testid="unknown-save">
            <p>It is not known yet whether your last save reached ContextLayer.</p>
            <button type="button" class="btn-secondary mt-2" @click="editMode.checkSave()">
              Check again
            </button>
          </div>
          <button
            type="button"
            class="btn mt-2 w-full"
            :disabled="busy || !dirty || state.conflict || state.unknownSave"
            data-testid="save"
            @click="editMode.save()"
          >
            Save draft
          </button>
        </footer>
      </template>
    </template>
  </main>
</template>
