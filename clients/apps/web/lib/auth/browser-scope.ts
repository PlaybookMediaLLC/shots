import {
  SCOPE_USER_PARAM,
  SCOPE_WORKSPACE_PARAM,
  type WorkspaceRequestScope,
  workspaceScopeHeaders,
} from './request-scope'

let scope: WorkspaceRequestScope | null = null
let installed = false

/** Whether a browser request goes to this app's own API, the only place scope means anything. */
export function isOwnApiRequest(input: RequestInfo | URL, origin: string): boolean {
  const url = new URL(input instanceof Request ? input.url : String(input), origin)
  return url.origin === origin && url.pathname.startsWith('/api/')
}

/** Links that start something in the workspace by leaving the page, so they can't send headers. */
const SCOPED_NAVIGATIONS = /^(\/[a-z]{2}(-[A-Z]{2})?)?\/integrations\/|^\/api\/integrations\//

/** Whether following this path starts something in the workspace. */
export function isScopedNavigation(pathname: string): boolean {
  return SCOPED_NAVIGATIONS.test(pathname)
}

/** The same link, with the workspace on this tab's screen for the server to check. */
export function withBrowserScope(href: string, origin: string): string {
  if (!scope) return href
  const url = new URL(href, origin)
  url.searchParams.set(SCOPE_USER_PARAM, scope.userId)
  url.searchParams.set(SCOPE_WORKSPACE_PARAM, scope.workspaceId)
  return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : url.href
}

/**
 * Bind every API request from this tab to the workspace on its screen, so that
 * after another tab switches the shared session, a write is refused with a 403
 * (`matchesWorkspaceScope`) rather than landing in the other workspace. It
 * wraps `fetch` once so every client, present and future, is covered; signed
 * storage uploads go elsewhere and carry no tenant context to protect.
 */
export function bindBrowserScope(next: WorkspaceRequestScope): () => void {
  scope = next
  if (!installed) {
    installed = true
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      if (!scope || !isOwnApiRequest(input, window.location.origin)) return original(input, init)
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      )
      for (const [name, value] of Object.entries(workspaceScopeHeaders(scope)))
        if (!headers.has(name)) headers.set(name, value)
      return original(input, { ...init, headers })
    }
    // Links are scoped as they are followed, so none can be rendered before the scope is known.
    const scopeLink = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null
      if (link && link.origin === window.location.origin && isScopedNavigation(link.pathname))
        link.href = withBrowserScope(link.href, window.location.origin)
    }
    document.addEventListener('click', scopeLink, true)
    document.addEventListener('auxclick', scopeLink, true)
  }
  return () => {
    if (scope === next) scope = null
  }
}
