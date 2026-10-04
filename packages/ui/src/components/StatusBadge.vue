<script setup lang="ts">
import { computed } from 'vue'

import type { StatusTone } from '../types'

const { tone = 'neutral' } = defineProps<{ tone?: StatusTone }>()

const TONE_CLASSES: Record<StatusTone, { badge: string; dot: string }> = {
  success: { badge: 'bg-emerald-50 text-emerald-800 ring-emerald-600/25', dot: 'bg-emerald-500' },
  warning: { badge: 'bg-amber-50 text-amber-800 ring-amber-600/25', dot: 'bg-amber-500' },
  danger: { badge: 'bg-rose-50 text-rose-800 ring-rose-600/25', dot: 'bg-rose-500' },
  neutral: { badge: 'bg-slate-100 text-slate-700 ring-slate-500/25', dot: 'bg-slate-400' },
}

const classes = computed(() => TONE_CLASSES[tone])
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset"
    :class="classes.badge"
    :data-tone="tone"
  >
    <span class="size-1.5 shrink-0 rounded-full" :class="classes.dot" aria-hidden="true" />
    <slot />
  </span>
</template>
