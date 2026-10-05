<script setup lang="ts">
import { WORKSPACE_ROLES, type Member, type WorkspaceRole } from '@contextlayer/shared'
import { computed, reactive, shallowRef, useId, watch } from 'vue'
import { useRouter } from 'vue-router'

import AppButton from '../../components/AppButton.vue'
import TextField from '../../components/TextField.vue'
import { describeError } from '../../lib/errors'
import { session } from '../auth/session'
import { useCurrentWorkspace } from './current-workspace'
import RoleBadge from './RoleBadge.vue'
import { canManageMembers, ROLE_LABELS } from './roles'
import * as api from './workspaces-api'

const router = useRouter()
const workspace = useCurrentWorkspace()
const roleSelectId = useId()

const members = shallowRef<Member[]>([])
const loading = shallowRef(true)
const error = shallowRef<string>()
const notice = shallowRef<string>()
const busyUserId = shallowRef<string>()

const myRole = computed<WorkspaceRole>(() => workspace.value?.role ?? 'member')
const canManage = computed(() => canManageMembers(myRole.value))
const myUserId = computed(() => session.user.value?.id)
/** Only owners hand out or take away the owner role (the API enforces it too). */
const assignableRoles = computed(() =>
  WORKSPACE_ROLES.filter((role) => role !== 'owner' || myRole.value === 'owner'),
)

let controller: AbortController | undefined

async function load(workspaceId: string) {
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  error.value = undefined
  try {
    members.value = await api.listMembers(workspaceId, current.signal)
  } catch (cause) {
    if (!current.signal.aborted) error.value = describeError(cause)
  } finally {
    if (!current.signal.aborted) loading.value = false
  }
}

watch(
  () => workspace.value?.id,
  (id) => {
    if (id !== undefined) void load(id)
  },
  { immediate: true },
)

const invite = reactive<{ email: string; role: WorkspaceRole }>({ email: '', role: 'member' })
const inviting = shallowRef(false)
const inviteError = shallowRef<string>()

async function addMember() {
  if (!workspace.value) return
  if (invite.email.trim() === '') {
    inviteError.value = 'Enter the email of an existing ContextLayer account.'
    return
  }
  inviting.value = true
  inviteError.value = undefined
  try {
    const added = await api.addMember(workspace.value.id, {
      email: invite.email,
      role: invite.role,
    })
    notice.value = `${added.displayName} joined as ${ROLE_LABELS[added.role]}.`
    invite.email = ''
    await load(workspace.value.id)
  } catch (cause) {
    inviteError.value = describeError(cause)
  } finally {
    inviting.value = false
  }
}

/** The last owner cannot leave (the API answers 409), so the button is not offered. */
const isLastOwner = computed(
  () => myRole.value === 'owner' && members.value.filter((m) => m.role === 'owner').length <= 1,
)

function canEdit(member: Member): boolean {
  if (!canManage.value || member.userId === myUserId.value) return false
  return member.role !== 'owner' || myRole.value === 'owner'
}

async function changeRole(member: Member, event: Event) {
  if (!workspace.value) return
  const role = (event.target as HTMLSelectElement).value as WorkspaceRole
  busyUserId.value = member.userId
  error.value = undefined
  try {
    await api.changeMemberRole(workspace.value.id, member.userId, role)
    notice.value = `${member.displayName} is now ${ROLE_LABELS[role]}.`
  } catch (cause) {
    error.value = describeError(cause)
  } finally {
    busyUserId.value = undefined
    await load(workspace.value.id)
  }
}

async function remove(member: Member) {
  if (!workspace.value) return
  const workspaceId = workspace.value.id
  const leaving = member.userId === myUserId.value
  busyUserId.value = member.userId
  error.value = undefined
  try {
    await api.removeMember(workspaceId, member.userId)
    if (leaving) {
      session.removeWorkspace(workspaceId)
      await router.replace('/')
      return
    }
    notice.value = `${member.displayName} was removed.`
    await load(workspaceId)
  } catch (cause) {
    error.value = describeError(cause)
  } finally {
    busyUserId.value = undefined
  }
}

const joinedFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
</script>

<template>
  <div v-if="workspace">
    <h1 class="text-2xl font-semibold tracking-tight">Members</h1>
    <p class="mt-1 text-sm text-slate-600">People with access to {{ workspace.name }}.</p>

    <p class="sr-only" role="status" aria-live="polite">{{ notice }}</p>

    <form
      v-if="canManage"
      class="mt-8 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-5"
      novalidate
      aria-label="Add a member"
      @submit.prevent="addMember"
    >
      <TextField
        v-model="invite.email"
        class="min-w-64 flex-1"
        label="Email of an existing account"
        type="email"
        autocomplete="off"
        :error="inviteError"
      />
      <div>
        <label :for="roleSelectId" class="block text-sm font-medium text-slate-800">Role</label>
        <select
          :id="roleSelectId"
          v-model="invite.role"
          class="mt-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-2 focus:outline-offset-1 focus:outline-brand-600"
        >
          <option v-for="role in assignableRoles" :key="role" :value="role">
            {{ ROLE_LABELS[role] }}
          </option>
        </select>
      </div>
      <AppButton type="submit" :loading="inviting">Add member</AppButton>
    </form>

    <p
      v-if="error"
      role="alert"
      class="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800"
    >
      {{ error }}
    </p>

    <div class="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table class="w-full text-left text-sm" :aria-busy="loading ? 'true' : undefined">
        <caption class="sr-only">
          Members of
          {{
            workspace.name
          }}
        </caption>
        <thead class="border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase">
          <tr>
            <th scope="col" class="px-5 py-3">Name</th>
            <th scope="col" class="px-5 py-3">Role</th>
            <th scope="col" class="hidden px-5 py-3 md:table-cell">Joined</th>
            <th scope="col" class="px-5 py-3"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-if="loading && members.length === 0">
            <td colspan="4" class="px-5 py-6 text-slate-600">Loading members…</td>
          </tr>
          <tr v-for="member in members" :key="member.userId" data-testid="member-row">
            <td class="px-5 py-3">
              <p class="font-medium text-slate-900">
                {{ member.displayName }}
                <span v-if="member.userId === myUserId" class="font-normal text-slate-500"
                  >(you)</span
                >
              </p>
              <p class="text-slate-600">{{ member.email }}</p>
            </td>
            <td class="px-5 py-3">
              <template v-if="canEdit(member)">
                <label :for="`role-${member.userId}`" class="sr-only">
                  Role of {{ member.displayName }}
                </label>
                <select
                  :id="`role-${member.userId}`"
                  :value="member.role"
                  :disabled="busyUserId === member.userId"
                  class="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:outline-2 focus:outline-offset-1 focus:outline-brand-600"
                  @change="changeRole(member, $event)"
                >
                  <option v-for="role in assignableRoles" :key="role" :value="role">
                    {{ ROLE_LABELS[role] }}
                  </option>
                </select>
              </template>
              <RoleBadge v-else :role="member.role" />
            </td>
            <td class="hidden px-5 py-3 text-slate-600 md:table-cell">
              {{ joinedFormat.format(new Date(member.joinedAt)) }}
            </td>
            <td class="px-5 py-3 text-right">
              <AppButton
                v-if="member.userId === myUserId && !isLastOwner"
                variant="secondary"
                :loading="busyUserId === member.userId"
                @click="remove(member)"
              >
                Leave
              </AppButton>
              <AppButton
                v-else-if="canEdit(member)"
                variant="danger"
                :loading="busyUserId === member.userId"
                @click="remove(member)"
              >
                Remove<span class="sr-only"> {{ member.displayName }}</span>
              </AppButton>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
