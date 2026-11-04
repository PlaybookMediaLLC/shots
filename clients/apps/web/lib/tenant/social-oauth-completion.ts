import { z } from 'zod'
import { socialOAuthContextSchema, socialOAuthProviderSchema } from 'screenshot-studio-backend-sdk'

/** A completion URL only identifies the session-bound attempt; it grants no access. */
export const socialOAuthCompletionQuerySchema = z.strictObject({
  provider: socialOAuthProviderSchema,
  state: z.string().min(1).max(512),
})

/** Safe server-rendered confirmation fields, rechecked against the hydrated session. */
export const socialOAuthCompletionViewSchema = socialOAuthContextSchema
  .pick({ organizationId: true, returnPath: true })
  .extend({
    provider: socialOAuthProviderSchema,
    workspaceName: z.string(),
    userId: z.string(),
    sessionId: z.string(),
  })

/** Remove the provider code from the address bar before resolving the original workspace. */
export function socialOAuthCompletionRedirect(
  provider: z.input<typeof socialOAuthProviderSchema>,
  state: string
): Response {
  const input = socialOAuthCompletionQuerySchema.parse({ provider, state })
  return new Response(null, {
    status: 303,
    headers: {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      Location: `/integrations/social/${input.provider}/complete?${new URLSearchParams({ state: input.state })}`,
    },
  })
}

/** The destination is constrained by the persisted OAuth return-path contract. */
export function socialOAuthCompletedPath(
  input: Pick<z.output<typeof socialOAuthCompletionViewSchema>, 'returnPath' | 'provider'>
): string {
  return `${input.returnPath || '/settings/channels'}?${new URLSearchParams({ connected: input.provider })}`
}
