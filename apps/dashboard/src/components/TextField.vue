<script setup lang="ts">
import { computed, useId } from 'vue'

const model = defineModel<string>({ required: true })

const props = defineProps<{
  label: string
  type?: 'text' | 'email' | 'password'
  autocomplete?: string
  hint?: string | undefined
  error?: string | undefined
  required?: boolean
  maxlength?: number
}>()

const id = useId()
const hintId = `${id}-hint`
const errorId = `${id}-error`
const describedBy = computed(() => {
  const ids = [props.hint && !props.error ? hintId : '', props.error ? errorId : '']
  return ids.filter(Boolean).join(' ') || undefined
})
</script>

<template>
  <div>
    <label :for="id" class="block text-sm font-medium text-slate-800">{{ label }}</label>
    <input
      :id="id"
      v-model="model"
      :type="type ?? 'text'"
      :autocomplete="autocomplete"
      :required="required"
      :maxlength="maxlength"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="describedBy"
      class="mt-1.5 block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-xs transition-colors placeholder:text-slate-400 focus:outline-2 focus:outline-offset-1 focus:outline-brand-600"
      :class="error ? 'border-rose-400' : 'border-slate-300 hover:border-slate-400'"
    />
    <p v-if="hint && !error" :id="hintId" class="mt-1.5 text-xs text-slate-600">{{ hint }}</p>
    <p v-if="error" :id="errorId" class="mt-1.5 text-xs font-medium text-rose-700">{{ error }}</p>
  </div>
</template>
