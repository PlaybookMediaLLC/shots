import { z } from 'zod'

/** The person and workspace a browser operation started in. */
export const workspaceRequestScopeSchema = z.object({
  userId: z.string().min(1).max(160),
  workspaceId: z.string().min(1).max(160),
})

/** A caller expectation that narrows session authority; it never grants access. */
export type WorkspaceRequestScope = z.infer<typeof workspaceRequestScopeSchema>

/** The query names of a navigation's scope, for links that can't send headers. */
export const SCOPE_USER_PARAM = 'scopeUser'
export const SCOPE_WORKSPACE_PARAM = 'scopeWorkspace'

/** Bind a browser request to the context displayed when it began. */
export function workspaceScopeHeaders(scope: WorkspaceRequestScope) {
  return { 'x-playbook-user': scope.userId, 'x-playbook-workspace': scope.workspaceId }
}

/**
 * A top-level navigation can't set headers, so a link that starts something
 * in the workspace carries the same expectation in its query. The access check
 * then treats it exactly as it treats the headers: it can only narrow access.
 */
export function headersWithNavigationScope(request: Request): Headers {
  const headers = new Headers(request.headers)
  const query = new URL(request.url).searchParams
  const userId = query.get(SCOPE_USER_PARAM)
  const workspaceId = query.get(SCOPE_WORKSPACE_PARAM)
  if (userId && workspaceId)
    for (const [name, value] of Object.entries(workspaceScopeHeaders({ userId, workspaceId })))
      headers.set(name, value)
  return headers
}

/** Legacy callers omit both headers; scoped callers must match both identities. */
export function matchesWorkspaceScope(headers: Headers, scope: WorkspaceRequestScope): boolean {
  const user = headers.get('x-playbook-user')
  const workspace = headers.get('x-playbook-workspace')
  return (
    (user === null && workspace === null) ||
    (user === scope.userId && workspace === scope.workspaceId)
  )
}
