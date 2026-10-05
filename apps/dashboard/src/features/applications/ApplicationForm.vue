<script setup lang="ts">
import {
  applicationNameSchema,
  MAX_APPLICATION_ORIGINS,
  originListSchema,
  parseOrigin,
} from '@contextlayer/shared'
import { shallowRef } from 'vue'

import AppButton from '../../components/AppButton.vue'
import ErrorMessage from '../../components/ErrorMessage.vue'
import TextAreaField from '../../components/TextAreaField.vue'
import TextField from '../../components/TextField.vue'

const props = defineProps<{
  submitLabel: string
  initial?: { name: string; origins: string[] } | undefined
  busy?: boolean
  error?: string | undefined
}>()

const emit = defineEmits<{
  submit: [value: { name: string; origins: string[] }]
  cancel: []
}>()

const name = shallowRef(props.initial?.name ?? '')
const originsText = shallowRef(props.initial?.origins.join('\n') ?? '')
const nameError = shallowRef<string>()
const originsError = shallowRef<string>()

/** The same rules as the API (packages/shared/src/origins.ts), checked line by line. */
function validateOrigins(lines: string[]): string | undefined {
  if (lines.length === 0) return 'Add at least one origin, for example https://crm.example.com.'
  for (const line of lines) {
    const result = parseOrigin(line)
    if (!result.ok) return `${line} — ${result.error}`
  }
  const list = originListSchema.safeParse(lines)
  return list.success ? undefined : list.error.issues[0]?.message
}

function submit() {
  const parsedName = applicationNameSchema.safeParse(name.value)
  nameError.value = parsedName.success ? undefined : 'Use 1 to 80 characters.'
  const lines = originsText.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  originsError.value = validateOrigins(lines)
  const origins = originListSchema.safeParse(lines)
  if (!parsedName.success || originsError.value !== undefined || !origins.success) return
  emit('submit', { name: parsedName.data, origins: origins.data })
}
</script>

<template>
  <form class="space-y-5" novalidate @submit.prevent="submit">
    <ErrorMessage :message="error" />
    <TextField
      v-model="name"
      label="Application name"
      hint="As your team calls it, for example Salesforce or Internal CRM."
      required
      :maxlength="80"
      :error="nameError"
    />
    <TextAreaField
      v-model="originsText"
      label="Origins"
      :hint="`One per line, scheme and host only: https://crm.example.com or https://erp.example.com:8443. Up to ${MAX_APPLICATION_ORIGINS}. The extension will only run on these sites.`"
      :rows="3"
      monospace
      required
      :error="originsError"
    />
    <div class="flex items-center justify-end gap-3">
      <AppButton variant="secondary" @click="emit('cancel')">Cancel</AppButton>
      <AppButton type="submit" :loading="busy">{{ submitLabel }}</AppButton>
    </div>
  </form>
</template>
