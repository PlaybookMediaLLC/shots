import { type WorkspaceRequestScope, workspaceScopeHeaders } from './request-scope'

let scope: WorkspaceRequestScope | null = null
let installed = false

/** Whether a browser request goes to this app's own API, the only place scope means anything. */
export function isOwnApiRequest(input: RequestInfo | URL, origin: string): boolean {
  const url = new URL(input instanceof Request ? input.url : String(input), origin)
  return url.origin === origin && url.pathname.startsWith('/api/')
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
  }
  return () => {
    if (scope === next) scope = null
  }
}
