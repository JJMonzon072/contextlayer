/**
 * Imported first by every extension entry point (worker, popup, side panel).
 * Zod 4 decides at schema construction whether to compile parsers with
 * `new Function`, after a probe that the MV3 CSP (`script-src 'self'`) blocks
 * and reports as a violation. `jitless` skips both the probe and the
 * compilation, so it must run before any module defines a schema.
 */
import { z } from 'zod'

z.config({ jitless: true })
