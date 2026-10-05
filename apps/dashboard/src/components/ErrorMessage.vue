<script setup lang="ts">
defineProps<{ message: string | undefined }>()
</script>

<template>
  <p
    v-if="message"
    role="alert"
    class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800"
  >
    {{ message }}<slot />
  </p>
</template>
