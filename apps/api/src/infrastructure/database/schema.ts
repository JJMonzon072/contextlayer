/**
 * Drizzle schema entry point (read by drizzle-kit and by the runtime client).
 * Each module owns its tables; this file only re-exports them.
 */
export * from '../../modules/applications/applications.schema.js'
export * from '../../modules/auth/auth.schema.js'
export * from '../../modules/extension/extension.schema.js'
export * from '../../modules/guides/guides.schema.js'
export * from '../../modules/workspaces/workspaces.schema.js'
