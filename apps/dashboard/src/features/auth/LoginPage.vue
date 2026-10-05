<script setup lang="ts">
import { reactive, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import AppButton from '../../components/AppButton.vue'
import TextField from '../../components/TextField.vue'
import { describeError } from '../../lib/errors'
import { safeRedirect } from '../../router'
import AuthLayout from './AuthLayout.vue'
import { session } from './session'

const router = useRouter()
const route = useRoute()

const form = reactive({ email: '', password: '' })
const fieldErrors = reactive<{ email?: string | undefined; password?: string | undefined }>({})
const formError = shallowRef<string>()
const submitting = shallowRef(false)

async function submit() {
  fieldErrors.email = form.email.trim() === '' ? 'Enter your email.' : undefined
  fieldErrors.password = form.password === '' ? 'Enter your password.' : undefined
  if (fieldErrors.email !== undefined || fieldErrors.password !== undefined) return

  submitting.value = true
  formError.value = undefined
  try {
    await session.login({ email: form.email, password: form.password })
    await router.replace(safeRedirect(route.query.redirect) ?? '/')
  } catch (error) {
    // The API answers unknown email and wrong password identically.
    formError.value = describeError(error)
    form.password = ''
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthLayout title="Sign in" subtitle="Welcome back. Sign in to manage your workspaces.">
    <form class="space-y-5" novalidate @submit.prevent="submit">
      <p
        v-if="formError"
        role="alert"
        class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800"
      >
        {{ formError }}
      </p>
      <TextField
        v-model="form.email"
        label="Email"
        type="email"
        autocomplete="email"
        required
        :error="fieldErrors.email"
      />
      <TextField
        v-model="form.password"
        label="Password"
        type="password"
        autocomplete="current-password"
        required
        :error="fieldErrors.password"
      />
      <AppButton type="submit" class="w-full" :loading="submitting">
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </AppButton>
    </form>
    <p class="mt-8 text-sm text-slate-600">
      New to ContextLayer?
      <RouterLink
        :to="{ name: 'register' }"
        class="font-medium text-brand-700 underline-offset-2 hover:underline"
      >
        Create an account
      </RouterLink>
    </p>
  </AuthLayout>
</template>
