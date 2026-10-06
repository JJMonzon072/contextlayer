<script setup lang="ts">
import type { TargetDescriptor } from '@contextlayer/shared'
import { computed } from 'vue'

import { summarizeTarget } from '../authoring/target-summary'
import { targetDetails } from './target-details'

/**
 * The element a step points at: none yet, being selected on the page, a new
 * selection waiting for review, or the stored target. Every captured value is
 * listed (text only) so the author can check what will be saved.
 */
const props = defineProps<{
  stepNumber: number
  target: TargetDescriptor | null
  capturing: boolean
  review: TargetDescriptor | null
  note: string | null
  disabled: boolean
  /** The element was selected on this page (its preview can be shown). */
  previewable: boolean
  previewing: boolean
  previewNote: string | null
}>()

const emit = defineEmits<{
  select: []
  cancel: []
  accept: []
  discard: []
  remove: []
  preview: []
  hidePreview: []
}>()

const shown = computed(() => props.review ?? props.target)
const summary = computed(() => (shown.value ? summarizeTarget(shown.value) : undefined))
const details = computed(() => (shown.value ? targetDetails(shown.value) : []))
const strengthText = {
  stable: 'Stable target',
  semantic: 'Found by its name',
  weak: 'Weak target',
} as const
const strengthClass = {
  stable: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  semantic: 'bg-sky-50 text-sky-800 ring-sky-200',
  weak: 'bg-amber-50 text-amber-900 ring-amber-200',
} as const
</script>

<template>
  <div class="mt-3 rounded-lg bg-slate-50 p-2.5" data-testid="target">
    <p class="text-xs font-semibold tracking-wide text-slate-500 uppercase">Target</p>

    <p v-if="capturing" class="mt-1 text-slate-800" data-testid="target-capturing">
      Click the element on the page. Press Esc on the page to cancel.
    </p>
    <p v-else-if="!shown" class="mt-1 text-slate-600" data-testid="target-none">
      No element selected. The step shows without pointing at anything.
    </p>

    <template v-if="shown && summary && !capturing">
      <p v-if="review" class="mt-1 text-xs font-medium text-brand-700">
        New selection: review it before using it.
      </p>
      <p class="mt-1 font-medium break-words text-slate-900" data-testid="target-label">
        {{ summary.label }}
      </p>
      <p class="mt-1">
        <span
          class="inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1"
          :class="strengthClass[summary.strength]"
          data-testid="target-strength"
          >{{ strengthText[summary.strength] }}</span
        >
      </p>
      <ul class="mt-1 list-disc pl-5 text-xs text-slate-700" data-testid="target-notes">
        <li v-for="line in summary.notes" :key="line">{{ line }}</li>
      </ul>
      <details class="mt-2 text-xs text-slate-700">
        <summary class="cursor-pointer font-medium text-slate-800">What will be saved</summary>
        <dl class="mt-1 space-y-1" data-testid="target-details">
          <div v-for="(line, index) in details" :key="index">
            <dt class="text-slate-500">{{ line.label }}</dt>
            <dd class="font-mono break-all">{{ line.value }}</dd>
          </div>
        </dl>
      </details>
    </template>

    <p v-if="note && !capturing" class="mt-1 text-amber-900" role="alert">{{ note }}</p>
    <p v-if="previewNote && !capturing" class="mt-1 text-slate-700" data-testid="preview-note">
      {{ previewNote }}
    </p>

    <div class="mt-2 flex flex-wrap gap-2">
      <template v-if="capturing">
        <button type="button" class="btn-secondary" @click="emit('cancel')">
          Cancel selection
        </button>
      </template>
      <template v-else-if="review">
        <button type="button" class="btn" :disabled="disabled" @click="emit('accept')">
          Use this element
        </button>
        <button type="button" class="btn-secondary" :disabled="disabled" @click="emit('select')">
          Select again
        </button>
        <button type="button" class="btn-secondary" @click="emit('discard')">Discard</button>
      </template>
      <template v-else>
        <button
          type="button"
          class="btn-secondary"
          :disabled="disabled"
          :aria-label="`${target ? 'Reselect' : 'Select'} element for step ${stepNumber}`"
          @click="emit('select')"
        >
          {{ target ? 'Reselect element' : 'Select element' }}
        </button>
        <button
          v-if="target && !previewing"
          type="button"
          class="btn-secondary"
          :disabled="disabled"
          :aria-label="`Preview step ${stepNumber} on the page`"
          :title="previewable ? undefined : 'Select the element again on this page to preview it.'"
          @click="emit('preview')"
        >
          Preview
        </button>
        <button
          v-if="previewing"
          type="button"
          class="btn-secondary"
          :aria-label="`Hide the preview of step ${stepNumber}`"
          @click="emit('hidePreview')"
        >
          Hide preview
        </button>
        <button
          v-if="target"
          type="button"
          class="btn-secondary"
          :aria-label="`Remove target of step ${stepNumber}`"
          @click="emit('remove')"
        >
          Remove target
        </button>
      </template>
    </div>
  </div>
</template>
