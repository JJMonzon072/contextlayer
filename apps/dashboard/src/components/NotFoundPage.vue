<script setup lang="ts">
import AppLogo from './AppLogo.vue'
</script>

<template>
  <main class="grid min-h-dvh place-items-center bg-slate-50 px-6 font-sans text-slate-900">
    <div class="max-w-sm text-center">
      <AppLogo class="mx-auto" />
      <h1 class="mt-6 text-2xl font-semibold tracking-tight">Page not found</h1>
      <p class="mt-2 text-slate-600">This page does not exist, or you do not have access to it.</p>
      <RouterLink
        to="/"
        class="mt-6 inline-block rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        Go to your workspace
      </RouterLink>
    </div>
  </main>
</template>
