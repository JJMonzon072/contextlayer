/**
 * The connection's life cycle inside one service worker (ADR 0015).
 *
 * Two generations say whether work that started earlier still applies:
 * - the attempt generation changes when an attempt is started, consumed,
 *   cancelled or abandoned (its dashboard tab closed), when a connection is
 *   installed and on Disconnect: a code exchange commits only if it did not;
 * - the credential generation changes when the stored connection is replaced,
 *   ends or is disconnected: a refresh, or the end of a connection after a
 *   401, applies only to the connection it started with.
 *
 * `exclusive` runs one transition at a time. A transition reads and writes
 * storage only and never waits for the network, so Disconnect or Cancel never
 * wait for a request in flight; the request's result is checked against the
 * generations when it comes back, inside its own transition.
 *
 * The state lives in memory on purpose: Chrome runs one instance of the
 * worker, and when it stops, its requests in flight stop with it (measured in
 * the Phase 4 spike), so no pending operation outlives the generations.
 */
export function createLifecycle() {
  let attempts = 0
  let credentials = 0
  let tail: Promise<unknown> = Promise.resolve()

  return {
    attemptGeneration: () => attempts,
    credentialGeneration: () => credentials,
    invalidateAttempts(): void {
      attempts += 1
    },
    invalidateCredentials(): void {
      credentials += 1
    },
    exclusive<T>(transition: () => Promise<T>): Promise<T> {
      const run = tail.then(() => transition())
      tail = run.catch(() => undefined)
      return run
    },
  }
}

export type Lifecycle = ReturnType<typeof createLifecycle>
