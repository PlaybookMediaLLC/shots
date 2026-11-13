import { z } from 'zod'
import { socialInstanceServerSchema } from './social-instances.ts'

/** Provider keys accepted by the existing OAuth adapters. */
export const socialOAuthProviderSchema = z.enum([
  'x',
  'instagram',
  'instagram-standalone',
  'linkedin',
  'linkedin-page',
  'tiktok',
  'youtube',
  'threads',
  'mastodon',
  'mastodon-custom',
  'facebook',
  'pinterest',
  'gmb',
])

/** Intent is immutable even when the active workspace changes during authorization. */
export const socialOAuthOperationSchema = z.enum(['CREATE_SET', 'ADD_ACCOUNT', 'RECONNECT'])

/** Safe routing and reconnect context persisted with the authorization attempt. */
export const socialOAuthStartOptionsSchema = z.strictObject({
  instanceServer: socialInstanceServerSchema.optional(),
  operation: socialOAuthOperationSchema.optional(),
  creationVisibility: z.enum(['PRIVATE', 'WORKSPACE']).optional(),
  expectedConnectionId: z.string().min(1).max(160).optional(),
  returnPath: z
    .string()
    .regex(/^\/(?:settings\/publishing-brands|publish)\/[a-z0-9]{10,32}$/)
    .optional(),
})

/** One immutable creation, addition or reconnect target shared by connection methods. */
export const socialConnectionIntentSchema = socialOAuthStartOptionsSchema
  .omit({ instanceServer: true })
  .extend({ socialSetId: z.string().min(1).max(160).optional() })
  .superRefine((input, context) => {
    const operation = input.operation ?? (input.expectedConnectionId ? 'RECONNECT' : 'ADD_ACCOUNT')
    const valid =
      operation === 'CREATE_SET'
        ? !!input.creationVisibility && !input.socialSetId && !input.expectedConnectionId
        : operation === 'RECONNECT'
          ? !input.creationVisibility && !!input.socialSetId && !!input.expectedConnectionId
          : !input.creationVisibility && !input.expectedConnectionId
    if (!valid)
      context.addIssue({
        code: 'custom',
        message: 'Choose one connection operation and its owner or target.',
      })
  })

/** A first OAuth connection requires explicit ownership and a provider-specific server. */
export const socialOAuthBeginRequestSchema = socialConnectionIntentSchema
  .safeExtend({
    provider: socialOAuthProviderSchema,
    instanceServer: socialInstanceServerSchema.optional(),
  })
  .superRefine((input, context) => {
    if ((input.provider === 'mastodon-custom') !== !!input.instanceServer)
      context.addIssue({
        code: 'custom',
        path: ['instanceServer'],
        message: 'Choose a public Mastodon server only for a custom Mastodon connection.',
      })
  })

/** A provider URL that the backend has checked before persisting the attempt. */
export const socialOAuthBeginResponseSchema = z.object({ url: z.url({ protocol: /^https$/ }) })

/** The provider's credential-free exchange receipt. */
export const socialOAuthExchangeSchema = z.object({
  completed: z.boolean().optional(),
  id: z.string().min(1).max(160),
  pages: z
    .array(
      z.object({
        id: z.string().min(1).max(160),
        pageId: z.string().min(1).max(160),
        name: z.string().max(500).nullable().optional(),
      })
    )
    .max(500)
    .optional(),
})

/** Original context, resolved by the backend using the current session and state. */
export const socialOAuthContextSchema = z.object({
  completed: z.boolean().default(false),
  operation: socialOAuthOperationSchema.default('ADD_ACCOUNT'),
  organizationId: z.string().min(1),
  socialSetId: z.string().nullable(),
  returnPath: z.union([z.literal(''), socialOAuthStartOptionsSchema.shape.returnPath.unwrap()]),
})

/** One supported OAuth provider. */
export type OAuthProvider = z.output<typeof socialOAuthProviderSchema>
/** Safe OAuth options sent by the web facade. */
export type SocialOAuthStartOptions = z.input<typeof socialOAuthStartOptionsSchema>
/** A safe provider exchange receipt. */
export type OAuthExchange = z.output<typeof socialOAuthExchangeSchema>
/** The original workspace and return destination of an attempt. */
export type SocialOAuthContext = z.output<typeof socialOAuthContextSchema>
