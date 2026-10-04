/* eslint-disable no-console -- each extension context logs to its own DevTools console. */
const PREFIX = '[ContextLayer]'

export const logger = {
  info: (...args: unknown[]) => {
    console.info(PREFIX, ...args)
  },
  warn: (...args: unknown[]) => {
    console.warn(PREFIX, ...args)
  },
  error: (...args: unknown[]) => {
    console.error(PREFIX, ...args)
  },
}
