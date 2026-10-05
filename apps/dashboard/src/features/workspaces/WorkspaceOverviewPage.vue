<script setup lang="ts">
import { useCurrentWorkspace } from './current-workspace'
import RoleBadge from './RoleBadge.vue'
import { ROLE_DESCRIPTIONS } from './roles'

const workspace = useCurrentWorkspace()

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
</script>

<template>
  <div v-if="workspace">
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="text-2xl font-semibold tracking-tight" data-testid="workspace-name">
        {{ workspace.name }}
      </h1>
      <RoleBadge :role="workspace.role" />
    </div>
    <p class="mt-1 text-sm text-slate-600">
      Created {{ dateFormat.format(new Date(workspace.createdAt)) }}
    </p>

    <div class="mt-8 grid gap-4 md:grid-cols-3">
      <section
        class="rounded-xl border border-slate-200 bg-white p-5"
        aria-labelledby="role-heading"
      >
        <h2 id="role-heading" class="text-sm font-semibold">Your role</h2>
        <p class="mt-2 text-sm text-slate-600">{{ ROLE_DESCRIPTIONS[workspace.role] }}</p>
      </section>
      <section
        class="rounded-xl border border-slate-200 bg-white p-5"
        aria-labelledby="members-heading"
      >
        <h2 id="members-heading" class="text-sm font-semibold">Members</h2>
        <p class="mt-2 text-sm text-slate-600">
          See who belongs to this workspace and their roles.
        </p>
        <RouterLink
          :to="{ name: 'members', params: { workspaceId: workspace.id } }"
          class="mt-3 inline-block text-sm font-medium text-brand-700 hover:underline"
        >
          Manage members
        </RouterLink>
      </section>
      <section
        class="rounded-xl border border-slate-200 bg-white p-5"
        aria-labelledby="applications-heading"
      >
        <h2 id="applications-heading" class="text-sm font-semibold">Applications and guides</h2>
        <p class="mt-2 text-sm text-slate-600">
          Register the web applications your team uses and write step-by-step guides for them.
        </p>
        <RouterLink
          :to="{ name: 'applications', params: { workspaceId: workspace.id } }"
          class="mt-3 inline-block text-sm font-medium text-brand-700 hover:underline"
        >
          Open applications
        </RouterLink>
      </section>
    </div>
  </div>
</template>
