<script setup lang="ts">
import { RICH_TEXT_MAX_CHARACTERS, STEP_PLACEMENTS, type StepPlacement } from '@contextlayer/shared'
import { computed, useId } from 'vue'

import AppButton from '../../components/AppButton.vue'
import TextAreaField from '../../components/TextAreaField.vue'
import TextField from '../../components/TextField.vue'
import type { DraftStep, StepErrors } from './guide-editor'
import { plainTextLength } from './rich-text'
import RichTextView from './RichTextView'

const props = defineProps<{
  step: DraftStep
  index: number
  total: number
  errors: StepErrors
  readOnly: boolean
}>()

const emit = defineEmits<{
  change: [patch: Partial<Pick<DraftStep, 'title' | 'text' | 'placement'>>]
  move: [offset: -1 | 1]
  remove: []
}>()

const placementId = useId()
const PLACEMENT_LABELS: Record<StepPlacement, string> = {
  auto: 'Automatic',
  top: 'Above the element',
  right: 'Right of the element',
  bottom: 'Below the element',
  left: 'Left of the element',
}

const number = computed(() => props.index + 1)
const length = computed(() =>
  props.step.text === undefined ? 0 : plainTextLength(props.step.text),
)
const targetLabel = computed(() => {
  const target = props.step.target
  if (!target) return undefined
  return target.element.accessibleName ?? target.element.text ?? `<${target.element.tag}>`
})
</script>

<template>
  <li
    class="rounded-xl border border-slate-200 bg-white p-5"
    data-testid="step-card"
    :aria-label="`Step ${String(number)}`"
  >
    <div class="flex flex-wrap items-center gap-2">
      <span
        class="grid size-7 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700"
        aria-hidden="true"
        >{{ number }}</span
      >
      <p class="flex-1 text-sm font-semibold text-slate-900">
        {{ step.title.trim() || 'Untitled step' }}
      </p>
      <template v-if="!readOnly">
        <AppButton variant="secondary" :disabled="index === 0" @click="emit('move', -1)">
          <span aria-hidden="true">↑</span><span class="sr-only">Move step {{ number }} up</span>
        </AppButton>
        <AppButton variant="secondary" :disabled="index === total - 1" @click="emit('move', 1)">
          <span aria-hidden="true">↓</span><span class="sr-only">Move step {{ number }} down</span>
        </AppButton>
        <AppButton variant="danger" @click="emit('remove')">
          Remove<span class="sr-only"> step {{ number }}</span>
        </AppButton>
      </template>
    </div>

    <div class="mt-4 space-y-4">
      <TextField
        :model-value="step.title"
        label="Step title"
        :maxlength="120"
        :error="errors.title"
        :readonly="readOnly"
        @update:model-value="emit('change', { title: $event })"
      />

      <TextAreaField
        v-if="step.text !== undefined"
        :model-value="step.text"
        label="Instructions"
        :hint="`What the learner should do. A blank line starts a new paragraph; lines starting with “- ” become a list. ${String(length)}/${String(RICH_TEXT_MAX_CHARACTERS)} characters.`"
        :rows="3"
        :error="errors.text"
        :readonly="readOnly"
        @update:model-value="emit('change', { text: $event })"
      />
      <div v-else>
        <p class="text-sm font-medium text-slate-800">Instructions</p>
        <div class="mt-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <RichTextView :document="step.body" />
        </div>
        <p class="mt-1.5 text-xs text-slate-600">
          This text uses formatting the dashboard cannot edit yet; it is kept as it is.
        </p>
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label :for="placementId" class="block text-sm font-medium text-slate-800"
            >Popover position</label
          >
          <select
            :id="placementId"
            :value="step.placement"
            :disabled="readOnly"
            class="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-2 focus:outline-offset-1 focus:outline-brand-600"
            @change="
              emit('change', {
                placement: ($event.target as HTMLSelectElement).value as StepPlacement,
              })
            "
          >
            <option v-for="placement in STEP_PLACEMENTS" :key="placement" :value="placement">
              {{ PLACEMENT_LABELS[placement] }}
            </option>
          </select>
        </div>
        <div>
          <p class="text-sm font-medium text-slate-800">Element</p>
          <p class="mt-1.5 text-sm text-slate-600" data-testid="step-target">
            <template v-if="targetLabel">Captured: {{ targetLabel }}</template>
            <template v-else>
              Not captured yet. You will pick it in the application with Edit Mode.
            </template>
          </p>
        </div>
      </div>
    </div>
  </li>
</template>
