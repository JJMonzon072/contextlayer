<script setup lang="ts">
import { workspaceNameSchema } from '@contextlayer/shared'
import { computed, shallowRef } from 'vue'
import { useRouter } from 'vue-router'

import AppButton from '../../components/AppButton.vue'
import AppLogo from '../../components/AppLogo.vue'
import TextField from '../../components/TextField.vue'
import { describeError } from '../../lib/errors'
import { session } from '../auth/session'
import { createWorkspace } from './workspaces-api'

const router = useRouter()
const name = shallowRef('')
const fieldError = shallowRef<string>()
const formError = shallowRef<string>()
const submitting = shallowRef(false)

const firstWorkspace = computed(() => session.workspaces.value.length === 0)

async function submit() {
  const parsed = workspaceNameSchema.safeParse(name.value)
  fieldError.value = parsed.success ? undefined : 'Use 1 to 80 characters.'
  if (!parsed.success) return

  submitting.value = true
  formError.value = undefined
  try {
    const workspace = await createWorkspace(parsed.data)
    session.addWorkspace(workspace)
    await router.replace({ name: 'workspace', params: { workspaceId: workspace.id } })
  } catch (error) {
    formError.value = describeError(error)
  } finally {
    submitting.value = false
  }
}

async function signOut() {
  await session.logout()
  await router.replace({ name: 'login' })
}
</script>

<template>
  <main class="grid min-h-dvh place-items-center bg-slate-50 px-6 py-12 font-sans text-slate-900">
    <div class="w-full max-w-md">
      <AppLogo :size="40" />
      <h1 class="mt-6 text-2xl font-semibold tracking-tight">
        {{ firstWorkspace ? 'Create your first workspace' : 'Create a workspace' }}
      </h1>
      <p class="mt-2 text-sm text-slate-600">
        A workspace holds one team's guides and members. You will be its owner and can invite others
        afterwards.
      </p>

      <form
        class="mt-8 space-y-5 rounded-xl border border-slate-200 bg-white p-6"
        novalidate
        @submit.prevent="submit"
      >
        <p
          v-if="formError"
          role="alert"
          class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800"
        >
          {{ formError }}
        </p>
        <TextField
          v-model="name"
          label="Workspace name"
          hint="For example: Customer Support, Sales Ops."
          required
          :maxlength="80"
          :error="fieldError"
        />
        <div class="flex items-center justify-between gap-3">
          <RouterLink
            v-if="!firstWorkspace"
            to="/"
            class="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </RouterLink>
          <span v-else />
          <AppButton type="submit" :loading="submitting">Create workspace</AppButton>
        </div>
      </form>

      <p class="mt-6 text-sm text-slate-600">
        Signed in as {{ session.user.value?.email }} ·
        <button type="button" class="font-medium text-brand-700 hover:underline" @click="signOut">
          Sign out
        </button>
      </p>
    </div>
  </main>
</template>
