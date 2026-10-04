import { effectScope } from 'vue'
import { describe, expect, it } from 'vitest'

import { useApiHealth } from '../src/features/system-status/useApiHealth'

/** A request that never answers, like an API stuck at a breakpoint. */
function hangingRequest(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => {
      reject(signal.reason as Error)
    })
  })
}

describe('useApiHealth', () => {
  it('turns a request that never answers into an error after the timeout', async () => {
    const scope = effectScope()
    const health = scope.run(() => useApiHealth(hangingRequest, { timeoutMs: 20 }))
    if (!health) throw new Error('composable did not run')

    await health.refresh()

    expect(health.state.value.kind).toBe('error')
    scope.stop()
  })

  it('ignores the result of a check that a newer one replaced', async () => {
    const scope = effectScope()
    let calls = 0
    const health = scope.run(() =>
      useApiHealth((signal) => {
        calls += 1
        return calls === 1 ? hangingRequest(signal) : Promise.reject(new Error('second'))
      }),
    )
    if (!health) throw new Error('composable did not run')

    const first = health.refresh()
    await health.refresh()
    await first

    // The aborted first check must not overwrite the result of the second one.
    expect(health.state.value).toMatchObject({ kind: 'error' })
    expect(calls).toBe(2)
    scope.stop()
  })
})
