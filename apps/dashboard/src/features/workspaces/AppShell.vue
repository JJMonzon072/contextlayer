<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import AppButton from '../../components/AppButton.vue'
import AppLogo from '../../components/AppLogo.vue'
import { session } from '../auth/session'
import { useCurrentWorkspace } from './current-workspace'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'

const route = useRoute()
const router = useRouter()
const workspace = useCurrentWorkspace()
const signingOut = shallowRef(false)

const tabs = [
  { name: 'workspace', label: 'Overview' },
  { name: 'applications', label: 'Applications' },
  { name: 'members', label: 'Members' },
] as const

/** Application and guide pages live under the Applications tab. */
const activeTab = computed(() => {
  const name = String(route.name)
  if (name === 'connected-browsers') return undefined
  return name === 'workspace' || name === 'members' ? name : 'applications'
})

async function signOut() {
  signingOut.value = true
  try {
    await session.logout()
  } finally {
    signingOut.value = false
    await router.replace({ name: 'login' })
  }
}
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-slate-50 font-sans text-slate-900">
    <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
        <RouterLink
          to="/"
          class="flex items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          <AppLogo :size="28" />
          <span class="font-semibold tracking-tight">ContextLayer</span>
        </RouterLink>
        <WorkspaceSwitcher v-if="workspace" :current-id="workspace.id" />
        <nav v-if="workspace" aria-label="Workspace" class="flex gap-1">
          <RouterLink
            v-for="tab in tabs"
            :key="tab.name"
            :to="{ name: tab.name, params: { workspaceId: workspace.id } }"
            class="rounded-md px-3 py-1.5 text-sm font-medium hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            :class="activeTab === tab.name ? 'bg-slate-100 text-slate-900' : 'text-slate-600'"
            :aria-current="activeTab === tab.name ? 'page' : undefined"
          >
            {{ tab.label }}
          </RouterLink>
        </nav>
        <div class="ml-auto flex items-center gap-3">
          <div class="hidden text-right text-sm leading-tight sm:block" data-testid="current-user">
            <p class="font-medium">{{ session.user.value?.displayName }}</p>
            <p class="text-slate-600">{{ session.user.value?.email }}</p>
          </div>
          <RouterLink
            v-if="workspace"
            :to="{ name: 'connected-browsers', params: { workspaceId: workspace.id } }"
            class="rounded-md px-2 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            active-class="bg-slate-100 text-slate-900"
          >
            Connected browsers
          </RouterLink>
          <AppButton variant="secondary" :loading="signingOut" @click="signOut">Sign out</AppButton>
        </div>
      </div>
    </header>

    <main class="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <RouterView v-if="workspace" :key="String(route.params.workspaceId)" />
      <section v-else aria-labelledby="missing-workspace" class="max-w-md">
        <h1 id="missing-workspace" class="text-2xl font-semibold tracking-tight">
          Workspace not found
        </h1>
        <p class="mt-2 text-slate-600">
          It does not exist, or you are not a member of it. Ask its owner to add you.
        </p>
        <RouterLink
          to="/"
          class="mt-6 inline-block text-sm font-medium text-brand-700 hover:underline"
        >
          Back to your workspaces
        </RouterLink>
      </section>
    </main>

    <footer class="border-t border-slate-200 bg-white">
      <div class="mx-auto flex max-w-6xl justify-end px-6 py-3 text-xs text-slate-600">
        <RouterLink :to="{ name: 'status' }" class="hover:text-slate-900 hover:underline">
          System status
        </RouterLink>
      </div>
    </footer>
  </div>
</template>
