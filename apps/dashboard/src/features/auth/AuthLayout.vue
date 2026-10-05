<script setup lang="ts">
import AppLogo from '../../components/AppLogo.vue'

defineProps<{ title: string; subtitle: string }>()
</script>

<template>
  <div
    class="grid min-h-dvh bg-white font-sans text-slate-900 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]"
  >
    <aside
      class="relative hidden overflow-hidden bg-brand-900 px-12 py-14 text-brand-50 lg:flex lg:flex-col lg:justify-between"
    >
      <div class="flex items-center gap-3">
        <AppLogo :size="36" />
        <span class="text-lg font-semibold tracking-tight text-white">ContextLayer</span>
      </div>
      <div class="max-w-md">
        <p class="text-3xl leading-tight font-semibold tracking-tight text-balance text-white">
          Teach software where people actually use it.
        </p>
        <ul class="mt-8 space-y-3 text-sm text-brand-100">
          <li>Step-by-step guides on top of the apps your team already runs.</li>
          <li>No changes to those apps' code.</li>
          <li>Workspaces keep each team's guides and members separate.</li>
        </ul>
      </div>
      <p class="text-xs text-brand-200">Self-hosted · open source (MIT)</p>
      <div
        class="pointer-events-none absolute -right-24 -bottom-24 size-80 rounded-full bg-brand-600/30 blur-3xl"
        aria-hidden="true"
      />
    </aside>

    <main class="flex items-center justify-center px-6 py-12 sm:px-10">
      <div class="w-full max-w-sm">
        <div class="flex items-center gap-2.5 lg:hidden">
          <AppLogo />
          <span class="font-semibold tracking-tight">ContextLayer</span>
        </div>
        <h1 class="mt-8 text-2xl font-semibold tracking-tight lg:mt-0">{{ title }}</h1>
        <p class="mt-2 text-sm text-slate-600">{{ subtitle }}</p>
        <div class="mt-8">
          <slot />
        </div>
      </div>
    </main>
  </div>
</template>
