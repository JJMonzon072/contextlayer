<script setup lang="ts">
import type { GuideVersionSummary } from '@contextlayer/shared'

defineProps<{
  workspaceId: string
  guideId: string
  versions: GuideVersionSummary[]
  loading: boolean
}>()

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
</script>

<template>
  <section
    class="rounded-xl border border-slate-200 bg-white p-5"
    aria-labelledby="versions-heading"
  >
    <h2 id="versions-heading" class="text-sm font-semibold">Published versions</h2>
    <p v-if="loading && versions.length === 0" class="mt-2 text-sm text-slate-600">Loading…</p>
    <p v-else-if="versions.length === 0" class="mt-2 text-sm text-slate-600">
      Not published yet. Publishing freezes the saved draft into a read-only version that learners
      follow.
    </p>
    <ol v-else class="mt-3 divide-y divide-slate-100" aria-label="Published versions">
      <li v-for="item in versions" :key="item.version" class="py-2.5" data-testid="version-item">
        <RouterLink
          :to="{ name: 'guide-version', params: { workspaceId, guideId, version: item.version } }"
          class="text-sm font-medium text-brand-700 hover:underline"
        >
          Version {{ item.version }}
        </RouterLink>
        <p class="mt-0.5 text-xs text-slate-600">
          Published {{ dateFormat.format(new Date(item.publishedAt)) }}
          <template v-if="item.publishedBy"> by {{ item.publishedBy.displayName }}</template>
          · {{ item.stepCount }} {{ item.stepCount === 1 ? 'step' : 'steps' }}
        </p>
      </li>
    </ol>
  </section>
</template>
