import type { HealthReport } from '@contextlayer/shared'
import { onScopeDispose, readonly, shallowRef } from 'vue'

import { HttpError } from '../../lib/http'
import { fetchHealthReport } from './health-api'

const REQUEST_TIMEOUT_MS = 5_000

export type HealthState =
  { kind: 'loading' } | { kind: 'ready'; report: HealthReport } | { kind: 'error'; message: string }

/**
 * Loads the API health report and exposes it as a small state machine.
 * Starting a new check aborts the previous one, so a slow response can never
 * overwrite a newer result.
 */
export function useApiHealth(
  fetchReport = fetchHealthReport,
  { timeoutMs = REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {},
) {
  const state = shallowRef<HealthState>({ kind: 'loading' })
  let controller: AbortController | undefined

  async function refresh(): Promise<void> {
    controller?.abort()
    const current = new AbortController()
    controller = current
    state.value = { kind: 'loading' }

    try {
      // A hung API must not leave the card in "Checking…" forever: the timeout
      // aborts the request and surfaces as an error (current.signal stays live).
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(timeoutMs)])
      const report = await fetchReport(signal)
      if (!current.signal.aborted) state.value = { kind: 'ready', report }
    } catch (error) {
      if (current.signal.aborted) return
      state.value = { kind: 'error', message: describeError(error) }
    }
  }

  onScopeDispose(() => {
    controller?.abort()
  })

  return { state: readonly(state), refresh }
}

function describeError(error: unknown): string {
  if (error instanceof HttpError && error.kind === 'invalid-response') {
    return 'The API answered with an unexpected format.'
  }
  return 'The ContextLayer API could not be reached. Is it running?'
}
