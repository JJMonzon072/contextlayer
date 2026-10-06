/**
 * Every file injected into customer pages: registered for enabled sites and
 * injected into open tabs by the worker, and measured by the content-script
 * budget (`scripts/budget.ts`). One list, so nothing is injected unmeasured.
 */
export const CONTENT_SCRIPT_FILES = ['content.js'] as const
