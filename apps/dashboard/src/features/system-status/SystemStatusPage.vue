<script setup lang="ts">
import AppLogo from '../../components/AppLogo.vue'
import SystemStatusCard from './SystemStatusCard.vue'
</script>

<template>
  <main class="min-h-dvh bg-slate-50 px-6 py-12 font-sans text-slate-900">
    <div class="mx-auto max-w-md">
      <RouterLink to="/" class="inline-flex items-center gap-2.5">
        <AppLogo :size="28" />
        <span class="font-semibold tracking-tight">ContextLayer</span>
      </RouterLink>
      <h1 class="mt-8 text-2xl font-semibold tracking-tight">System status</h1>
      <p class="mt-2 text-sm text-slate-600">Live health of the API and its database.</p>
      <div class="mt-6">
        <SystemStatusCard />
      </div>
    </div>
  </main>
</template>
