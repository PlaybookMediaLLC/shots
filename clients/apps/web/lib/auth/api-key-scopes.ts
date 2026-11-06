export const apiKeyScopes = [
  'artifact:read',
  'asset:write',
  'draft:comment',
  'draft:write',
  'onboarding:run',
  'post:publish',
  'post:schedule',
  'queue:write',
  'release:create',
  'source:write',
  'upload:sign',
] as const

export type ApiKeyScope = (typeof apiKeyScopes)[number]

export const apiKeyScopePermissions: Record<ApiKeyScope, Record<string, string[]>> = {
  'artifact:read': { artifact: ['read'] },
  'asset:write': { asset: ['write'] },
  'draft:comment': { draft: ['comment'] },
  'draft:write': { draft: ['write'] },
  'onboarding:run': { onboarding: ['run'] },
  'post:publish': { post: ['publish'] },
  'post:schedule': { post: ['schedule'] },
  'queue:write': { queue: ['write'] },
  'release:create': { release: ['create'] },
  'source:write': { source: ['write'] },
  'upload:sign': { upload: ['sign'] },
}

/** What each scope lets a key do, for the reference, settings, and agent consent. */
export const apiKeyScopeDescriptions: Record<ApiKeyScope, string> = {
  'artifact:read':
    'Read releases, campaigns, the review queue, the publishing schedule, and link previews; sign asset downloads; use the editor utilities.',
  'asset:write': 'Complete and delete asset uploads.',
  'draft:comment':
    'Add, reply, edit your own comments, and resolve discussions on workspace drafts. Never approves or publishes.',
  'draft:write':
    'Create, update, and delete content drafts. Posting to your accounts takes its own scope.',
  'onboarding:run': 'Read a product site into its profile and follow the run.',
  'post:publish':
    'Write and publish new posts to the accounts of your shared social sets, right away or at a time, with no review by a person unless the workspace requires approval. Cancelling them takes the scheduling scope too.',
  'post:schedule':
    'Schedule campaign posts and visuals a person approved, and cancel scheduled posts. It never approves anything.',
  'release:create': 'Create releases and draft campaigns, and submit drafts for review.',
  'queue:write':
    'Change future posting-slot suggestions and time zones. Does not approve, schedule, or move existing posts.',
  'source:write': 'Register and update release-intake sources.',
  'upload:sign': 'Sign asset uploads.',
}

/**
 * Why a key was refused. A key over its rate limit is valid: it should wait, not
 * go looking for a missing permission.
 */
export function apiKeyRefusal(error: { code?: unknown } | null | undefined): {
  message: string
  status: 403 | 429
} {
  return error?.code === 'RATE_LIMITED'
    ? {
        message: 'This API key is sending requests too quickly. Wait a minute, then retry.',
        status: 429,
      }
    : { message: 'The organization API key is not authorized for this action.', status: 403 }
}

/** What a new key or agent starts with: read the workspace, write posts and upload media. */
export const defaultAgentScopes: ApiKeyScope[] = [
  'artifact:read',
  'asset:write',
  'draft:write',
  'release:create',
  'upload:sign',
]

/**
 * What the consent page ticks for a client's request. `post:publish` puts words
 * on someone's public accounts, so only the person approving can tick it, even
 * when the client asks for it.
 */
export function preselectedAgentScopes(requested: readonly ApiKeyScope[]): ApiKeyScope[] {
  return (requested.length ? [...requested] : defaultAgentScopes).filter(
    (scope) => scope !== 'post:publish'
  )
}

/** Combine explicitly selected scopes without dropping actions on a shared resource. */
export function permissionsForApiKeyScopes(
  scopes: readonly ApiKeyScope[]
): Record<string, string[]> {
  const permissions: Record<string, string[]> = {}
  for (const scope of scopes) {
    for (const [resource, actions] of Object.entries(apiKeyScopePermissions[scope])) {
      permissions[resource] = [...new Set([...(permissions[resource] ?? []), ...actions])]
    }
  }
  return permissions
}
