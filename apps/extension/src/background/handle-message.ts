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
import type { Authoring } from './authoring'
import type { HelloResult, PageSender } from './site-access'

/**
 * Where a runtime message comes from. Content scripts live inside arbitrary web
 * pages (a compromised renderer can forge their messages), so they are trusted
 * less than extension pages such as the popup. The Edit Mode side panel is an
 * extension page too, told apart by its path so each page can only send the
 * requests it needs.
 */
export type SenderContext = 'extension-page' | 'side-panel' | 'content-script'

/** The side panel's document (`sidepanel.html?tab=…`). */
export const SIDE_PANEL_PATH = 'sidepanel.html'

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
  'site.requestActivation': ['extension-page'],
  'site.cancelActivation': ['extension-page'],
  'site.disable': ['extension-page'],
  'page.hello': ['content-script'],
  'authoring.attach': ['side-panel'],
  'authoring.state': ['side-panel'],
  'authoring.guides': ['side-panel'],
  'authoring.open': ['side-panel'],
  'authoring.create': ['side-panel'],
  'authoring.resume': ['side-panel'],
  'authoring.capture.start': ['side-panel'],
  'authoring.capture.cancel': ['side-panel'],
  'authoring.capture.take': ['side-panel'],
  'authoring.save': ['side-panel'],
  'authoring.local.write': ['side-panel'],
  'authoring.local.clear': ['side-panel'],
  'authoring.preview.show': ['side-panel'],
  'authoring.preview.hide': ['side-panel'],
  'authoring.exit': ['side-panel'],
  'authoring.detach': ['side-panel'],
  // The answer to a capture request; the worker checks it against the session.
  'picker.result': ['content-script'],
  'picker.cancelled': ['content-script'],
}

type Sender = Pick<chrome.runtime.MessageSender, 'id' | 'url' | 'tab'> & PageSender

export function classifySender(sender: Sender, extensionId: string): SenderContext | undefined {
  if (sender.id !== extensionId) return undefined
  // Set by the browser, not by the sender: extension pages have our own origin.
  const base = `chrome-extension://${extensionId}/`
  if (sender.url?.startsWith(base)) {
    const path = new URL(sender.url).pathname
    return path === `/${SIDE_PANEL_PATH}` ? 'side-panel' : 'extension-page'
  }
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
    requestActivation(tabId: number): Promise<{ intentId: string | null }>
    cancelActivation(intentId: string): Promise<{ cancelled: boolean }>
    disable(tabId: number): Promise<SiteStatusData>
    hello(sender: PageSender): Promise<HelloResult>
  }
  authoring: Authoring
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
    case 'site.requestActivation':
      return success(await deps.site.requestActivation(request.data.tabId))
    case 'site.cancelActivation':
      return success(await deps.site.cancelActivation(request.data.intentId))
    case 'site.disable': {
      const status = await deps.site.disable(request.data.tabId)
      // Edit Mode ends on a site that was turned off.
      await deps.authoring.verify()
      return success(status)
    }
    case 'page.hello': {
      const hello = await deps.site.hello(sender)
      if (hello.active) await deps.authoring.pageHello(sender)
      return success(hello)
    }
    case 'authoring.attach':
      return deps.authoring.attach(request.data.tabId)
    case 'authoring.state':
      return success(await deps.authoring.state(request.data.panelId))
    case 'authoring.guides':
      return deps.authoring.guides(request.data.panelId, request.data.applicationId)
    case 'authoring.open':
      return deps.authoring.open(
        request.data.panelId,
        request.data.applicationId,
        request.data.guideId,
      )
    case 'authoring.create':
      return deps.authoring.create(
        request.data.panelId,
        request.data.applicationId,
        request.data.title,
      )
    case 'authoring.resume':
      return deps.authoring.resume(request.data.panelId)
    case 'authoring.capture.start':
      return deps.authoring.startCapture(request.data.panelId)
    case 'authoring.capture.cancel':
      return deps.authoring.cancelCapture(request.data.panelId)
    case 'authoring.capture.take':
      return deps.authoring.takeCapture(request.data.panelId, request.data.captureId)
    case 'authoring.save':
      return deps.authoring.save(
        request.data.panelId,
        request.data.operationId,
        request.data.applicationId,
        request.data.guideId,
        request.data.request,
      )
    case 'authoring.local.write':
      return deps.authoring.writeLocal(request.data.panelId, request.data.draft)
    case 'authoring.local.clear':
      return deps.authoring.clearLocal(request.data.panelId, request.data.guideId)
    case 'authoring.preview.show':
      return deps.authoring.showPreview(
        request.data.panelId,
        request.data.captureId,
        request.data.title,
        request.data.lines,
      )
    case 'authoring.preview.hide':
      return deps.authoring.hidePreview(request.data.panelId)
    case 'authoring.exit':
      return deps.authoring.exit(request.data.panelId)
    case 'authoring.detach':
      return deps.authoring.detach(request.data.panelId)
    case 'picker.result':
      return success(
        await deps.authoring.pickerResult(sender, request.data.captureId, request.data.outcome),
      )
    case 'picker.cancelled':
      return success(
        await deps.authoring.pickerCancelled(sender, request.data.captureId, request.data.reason),
      )
  }
}
