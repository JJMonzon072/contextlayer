<script setup lang="ts">
import { PASSWORD_MIN_LENGTH, registerRequestSchema } from '@contextlayer/shared'
import { reactive, shallowRef } from 'vue'
import { useRouter } from 'vue-router'

import AppButton from '../../components/AppButton.vue'
import TextField from '../../components/TextField.vue'
import { describeError } from '../../lib/errors'
import AuthLayout from './AuthLayout.vue'
import { session } from './session'

type Field = 'displayName' | 'email' | 'password' | 'confirmPassword'

const router = useRouter()

const form = reactive({ displayName: '', email: '', password: '', confirmPassword: '' })
const fieldErrors = reactive<Partial<Record<Field, string>>>({})
const formError = shallowRef<string>()
const submitting = shallowRef(false)

const MESSAGES: Record<Exclude<Field, 'confirmPassword'>, string> = {
  displayName: 'Enter your name.',
  email: 'Enter a valid email address.',
  password: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
}

/** Same zod contract as the API, so client and server rules cannot drift. */
function validate(): boolean {
  for (const field of Object.keys(fieldErrors) as Field[]) fieldErrors[field] = undefined
  let valid = true
  const parsed = registerRequestSchema.safeParse(form)
  if (!parsed.success) {
    valid = false
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof typeof MESSAGES
      fieldErrors[field] = MESSAGES[field]
    }
  }
  if (form.confirmPassword !== form.password) {
    valid = false
    fieldErrors.confirmPassword = 'The passwords do not match.'
  }
  return valid
}

async function submit() {
  if (!validate()) return
  submitting.value = true
  formError.value = undefined
  try {
    await session.register({
      displayName: form.displayName,
      email: form.email,
      password: form.password,
    })
    await router.replace({ name: 'workspace-new' })
  } catch (error) {
    formError.value = describeError(error)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthLayout
    title="Create your account"
    subtitle="Set up ContextLayer for your team in under a minute."
  >
    <form class="space-y-5" novalidate @submit.prevent="submit">
      <p
        v-if="formError"
        role="alert"
        class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800"
      >
        {{ formError }}
      </p>
      <TextField
        v-model="form.displayName"
        label="Name"
        autocomplete="name"
        required
        :maxlength="80"
        :error="fieldErrors.displayName"
      />
      <TextField
        v-model="form.email"
        label="Work email"
        type="email"
        autocomplete="email"
        required
        :error="fieldErrors.email"
      />
      <TextField
        v-model="form.password"
        label="Password"
        type="password"
        autocomplete="new-password"
        required
        :hint="`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase works well.`"
        :error="fieldErrors.password"
      />
      <TextField
        v-model="form.confirmPassword"
        label="Confirm password"
        type="password"
        autocomplete="new-password"
        required
        :error="fieldErrors.confirmPassword"
      />
      <AppButton type="submit" class="w-full" :loading="submitting">
        {{ submitting ? 'Creating account…' : 'Create account' }}
      </AppButton>
    </form>
    <p class="mt-8 text-sm text-slate-600">
      Already have an account?
      <RouterLink
        :to="{ name: 'login' }"
        class="font-medium text-brand-700 underline-offset-2 hover:underline"
      >
        Sign in
      </RouterLink>
    </p>
  </AuthLayout>
</template>
