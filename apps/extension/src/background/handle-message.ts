import type { HealthReport } from '@contextlayer/shared'

import {
  backgroundRequestSchema,
  failure,
  success,
  type BackgroundRequest,
  type ApplicationListData,
  type ConnectionStatusData,
  type MessageResult,
  type SiteStatusData,
} from '../messaging/protocol'
import type { HelloResult, PageSender } from './site-access'

/**
 * Where a runtime message comes from. Content scripts live inside arbitrary web
 * pages (a compromised renderer can forge their messages), so they are trusted
 * less than extension pages such as the popup.
 */
export type SenderContext = 'extension-page' | 'content-script'

/**
 * Which contexts may send each request. Every command that reads or changes
 * the connection or site access is for extension pages only; a content script
 * may only ask whether it may run on its own page.
 */
const ALLOWED_SENDERS: Record<BackgroundRequest['type'], readonly SenderContext[]> = {
  'api.health.get': ['extension-page'],
  'connection.status': ['extension-page'],
  'connection.start': ['extension-page'],
  'connection.cancel': ['extension-page'],
  'connection.disconnect': ['extension-page'],
  'applications.list': ['extension-page'],
  'site.status': ['extension-page'],
  'site.enable': ['extension-page'],
  'site.disable': ['extension-page'],
  'page.hello': ['content-script'],
}

type Sender = Pick<chrome.runtime.MessageSender, 'id' | 'url' | 'tab'> & PageSender

export function classifySender(sender: Sender, extensionId: string): SenderContext | undefined {
  if (sender.id !== extensionId) return undefined
  // Set by the browser, not by the sender: extension pages have our own origin.
  if (sender.url?.startsWith(`chrome-extension://${extensionId}/`)) return 'extension-page'
  if (sender.tab !== undefined) return 'content-script'
  return undefined
}

export interface BackgroundDeps {
  extensionId: string
  fetchApiHealth: () => Promise<HealthReport>
  connection: {
    status(): Promise<ConnectionStatusData>
    start(): Promise<void>
    cancel(): Promise<void>
    disconnect(): Promise<{ serverConfirmed: boolean }>
  }
  site: {
    applications(): Promise<ApplicationListData>
    status(tabId: number): Promise<SiteStatusData>
    enable(tabId: number): Promise<SiteStatusData>
    disable(tabId: number): Promise<SiteStatusData>
    hello(sender: PageSender): Promise<HelloResult>
  }
  onApiError?: (error: unknown) => void
}

/**
 * Routes a runtime message received by the service worker. Kept free of
 * `chrome.*` calls so it can be unit-tested with plain inputs.
 */
export async function handleBackgroundMessage(
  message: unknown,
  sender: Sender,
  deps: BackgroundDeps,
): Promise<MessageResult<unknown>> {
  const context = classifySender(sender, deps.extensionId)
  if (context === undefined) {
    return failure('FORBIDDEN', 'Messages are only accepted from this extension.')
  }

  const request = backgroundRequestSchema.safeParse(message)
  if (!request.success) {
    return failure('BAD_REQUEST', 'Unsupported message.')
  }

  if (!ALLOWED_SENDERS[request.data.type].includes(context)) {
    return failure('FORBIDDEN', 'This request is not allowed from this context.')
  }

  switch (request.data.type) {
    case 'api.health.get':
      try {
        return success(await deps.fetchApiHealth())
      } catch (error) {
        deps.onApiError?.(error)
        return failure('API_UNREACHABLE', 'The ContextLayer API could not be reached.')
      }
    case 'connection.status':
      return success(await deps.connection.status())
    case 'connection.start':
      await deps.connection.start()
      return success(await deps.connection.status())
    case 'connection.cancel':
      await deps.connection.cancel()
      return success(await deps.connection.status())
    case 'connection.disconnect':
      return success(await deps.connection.disconnect())
    case 'applications.list':
      return success(await deps.site.applications())
    case 'site.status':
      return success(await deps.site.status(request.data.tabId))
    case 'site.enable':
      return success(await deps.site.enable(request.data.tabId))
    case 'site.disable':
      return success(await deps.site.disable(request.data.tabId))
    case 'page.hello':
      return success(await deps.site.hello(sender))
  }
}
