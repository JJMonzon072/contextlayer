<script setup lang="ts">
const { size = 32 } = defineProps<{ size?: number }>()
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 32 32" aria-hidden="true" class="shrink-0">
    <rect width="32" height="32" rx="8" fill="#4f46e5" />
    <rect x="7" y="9" width="18" height="4" rx="2" fill="#fff" opacity=".55" />
    <rect x="7" y="15" width="18" height="4" rx="2" fill="#fff" opacity=".8" />
    <rect x="7" y="21" width="12" height="4" rx="2" fill="#fff" />
  </svg>
</template>
