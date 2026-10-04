<script setup lang="ts">
import SystemStatusCard from './features/system-status/SystemStatusCard.vue'
</script>

<template>
  <div class="min-h-dvh bg-slate-50 font-sans text-slate-900">
    <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-5xl items-center gap-3 px-6 py-4">
        <img src="/favicon.svg" alt="" class="size-8" />
        <span class="text-lg font-semibold tracking-tight">ContextLayer</span>
        <span class="rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
          Dashboard
        </span>
      </div>
    </header>

    <main class="mx-auto grid max-w-5xl gap-8 px-6 py-12 md:grid-cols-[1fr_22rem]">
      <section aria-labelledby="welcome-heading">
        <p class="text-sm font-medium text-brand-700">Phase 1 · Foundation</p>
        <h1 id="welcome-heading" class="mt-2 text-3xl font-semibold tracking-tight text-balance">
          Interactive guides, inside the apps your team already uses.
        </h1>
        <p class="mt-4 max-w-prose text-slate-600">
          ContextLayer lets you build step-by-step walkthroughs on top of any web application and
          play them back for your users, without touching that application's code. Guide authoring,
          workspaces and analytics arrive in the next phases.
        </p>
      </section>

      <SystemStatusCard />
    </main>
  </div>
</template>
