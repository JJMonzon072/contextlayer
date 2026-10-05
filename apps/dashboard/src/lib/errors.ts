import { HttpError } from './http'

/** A short, safe message for the UI. Never shows raw server internals. */
export function describeError(
  error: unknown,
  fallback = 'Something went wrong. Try again.',
): string {
  if (!(error instanceof HttpError)) return fallback
  if (error.kind === 'network') return 'ContextLayer could not be reached. Check your connection.'
  if (error.status === 429) {
    const minutes = Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60))
    return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
  }
  if (error.status !== undefined && error.status >= 500) {
    return 'ContextLayer is having trouble right now. Try again in a moment.'
  }
  return error.apiMessage ?? fallback
}
