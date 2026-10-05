<script setup lang="ts">
import type { WorkspaceRole } from '@contextlayer/shared'

import { ROLE_LABELS } from './roles'

defineProps<{ role: WorkspaceRole }>()
</script>

<template>
  <span
    class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset"
    :class="
      role === 'owner' || role === 'admin'
        ? 'bg-brand-50 text-brand-800 ring-brand-600/20'
        : 'bg-slate-100 text-slate-700 ring-slate-500/20'
    "
  >
    {{ ROLE_LABELS[role] }}
  </span>
</template>
