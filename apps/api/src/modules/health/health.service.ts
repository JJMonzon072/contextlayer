import type { DependencyCheck, HealthReport } from '@contextlayer/shared'

export type DependencyProbe = () => Promise<void>

export interface HealthService {
  getReport(): Promise<HealthReport>
}

interface HealthServiceDeps {
  probes: { database: DependencyProbe }
  version: string
  logger: { warn(payload: object, message: string): void }
  /** A probe slower than this is reported as `down`. */
  timeoutMs?: number
  now?: () => Date
  uptimeSeconds?: () => number
}

const DEFAULT_TIMEOUT_MS = 2_000

export function createHealthService(deps: HealthServiceDeps): HealthService {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = deps.now ?? (() => new Date())
  const uptimeSeconds = deps.uptimeSeconds ?? (() => process.uptime())

  async function runProbe(name: string, probe: DependencyProbe): Promise<DependencyCheck> {
    const startedAt = performance.now()
    try {
      await withTimeout(probe(), timeoutMs)
      return { status: 'up', latencyMs: elapsedSince(startedAt) }
    } catch (error) {
      deps.logger.warn({ err: error, dependency: name }, 'health probe failed')
      return { status: 'down', latencyMs: elapsedSince(startedAt) }
    }
  }

  return {
    async getReport() {
      const database = await runProbe('database', deps.probes.database)

      return {
        status: database.status === 'up' ? 'ok' : 'unavailable',
        service: 'contextlayer-api',
        version: deps.version,
        timestamp: now().toISOString(),
        uptimeSeconds: Math.round(uptimeSeconds()),
        checks: { database },
      }
    },
  }
}

function elapsedSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
