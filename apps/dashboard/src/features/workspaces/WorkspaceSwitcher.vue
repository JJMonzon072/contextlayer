<script setup lang="ts">
import { useId } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { session } from '../auth/session'

const props = defineProps<{ currentId: string }>()

const NEW_WORKSPACE = '__new__'
const id = useId()
const route = useRoute()
const router = useRouter()

async function onChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (value === NEW_WORKSPACE) {
    await router.push({ name: 'workspace-new' })
    return
  }
  if (value === props.currentId) return
  // Stay on the same tab (overview or members) in the other workspace.
  await router.push({
    name: route.name === 'members' ? 'members' : 'workspace',
    params: { workspaceId: value },
  })
}
</script>

<template>
  <div>
    <label :for="id" class="sr-only">Current workspace</label>
    <select
      :id="id"
      :value="currentId"
      class="max-w-56 rounded-lg border border-slate-300 bg-white py-1.5 pr-8 pl-3 text-sm font-medium text-slate-900 hover:border-slate-400 focus:outline-2 focus:outline-offset-1 focus:outline-brand-600"
      @change="onChange"
    >
      <option
        v-for="workspace in session.workspaces.value"
        :key="workspace.id"
        :value="workspace.id"
      >
        {{ workspace.name }}
      </option>
      <option :value="NEW_WORKSPACE">+ New workspace…</option>
    </select>
  </div>
</template>
