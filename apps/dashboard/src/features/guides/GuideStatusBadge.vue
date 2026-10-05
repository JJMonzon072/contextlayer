<script setup lang="ts">
import type { GuideStatus } from '@contextlayer/shared'
import { computed } from 'vue'

const props = defineProps<{
  status: GuideStatus
  latestVersion: number | null
  hasUnpublishedChanges: boolean
}>()

const label = computed(() => {
  if (props.status === 'archived') return 'Archived'
  if (props.latestVersion === null) return 'Draft'
  return `Published · v${String(props.latestVersion)}`
})

const tone = computed(
  () =>
    ({
      archived: 'bg-amber-50 text-amber-800 ring-amber-200',
      draft: 'bg-slate-100 text-slate-700 ring-slate-200',
      published: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    })[props.status],
)
</script>

<template>
  <span class="inline-flex flex-wrap items-center gap-1.5">
    <span
      class="rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset"
      :class="tone"
      data-testid="guide-status"
      >{{ label }}</span
    >
    <span
      v-if="status === 'published' && hasUnpublishedChanges"
      class="rounded-md bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800 ring-1 ring-sky-200 ring-inset"
      >Unpublished changes</span
    >
  </span>
</template>
