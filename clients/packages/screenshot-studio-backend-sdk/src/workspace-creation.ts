import { z } from 'zod'
import { workspaceNameInputSchema } from './workspace-names.ts'

const metadataScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
const metadataValueSchema = z.union([
  metadataScalarSchema,
  z.array(metadataScalarSchema),
  z.record(z.string(), metadataScalarSchema),
])
const metadataNestedValueSchema = z.union([
  metadataValueSchema,
  z.array(metadataValueSchema),
  z.record(z.string(), metadataValueSchema),
])

/** JSON metadata limited to three container levels and 8 KiB. */
export const workspaceCreationMetadataSchema = z
  .record(z.string(), metadataNestedValueSchema)
  .refine((value) => {
    const encoded = JSON.stringify(value).replace(
      /[<>&\u2028\u2029]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
    )
    return new TextEncoder().encode(encoded).length <= 8192
  }, 'Workspace metadata must fit within 8 KiB.')

/** Optional logo reference, never fetched during creation. */
export const workspaceCreationLogoSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => {
    const url = new URL(value)
    return !url.username && !url.password
  }, 'Logo URLs must not contain credentials.')

/** Where a workspace's creator heard about Shots, as the backend's platform_signup_source stores it. */
export const signupSourceSchema = z.enum([
  'search',
  'ai_assistant',
  'x',
  'linkedin',
  'youtube',
  'tiktok_instagram',
  'reddit',
  'product_hunt_hacker_news',
  'friend_colleague',
  'newsletter_blog_podcast',
  'event_community',
  'other',
])

/** One of {@link signupSourceSchema}. */
export type SignupSource = z.infer<typeof signupSourceSchema>

/** The creator's answer: one source, and a short detail that only "other" takes. */
export const signupSourceInputSchema = z
  .strictObject({
    source: signupSourceSchema,
    // Plain text: the database refuses NUL, and nothing here needs a control character.
    detail: z.string().trim().max(200).regex(/^\P{Cc}*$/u, 'Use plain text.').optional(),
  })
  .refine((answer) => !answer.detail || answer.source === 'other', 'Only "Other" takes a detail.')

/** Session-owned creation intent; callers retain the key when retrying. */
export const workspaceCreationInputSchema = z.strictObject({
  name: workspaceNameInputSchema,
  slug: z.string().min(1),
  idempotencyKey: z.uuid().optional(),
  keepCurrentActiveOrganization: z.boolean().optional(),
  timeZone: z.string().max(100).optional(),
  logo: workspaceCreationLogoSchema.nullish(),
  metadata: workspaceCreationMetadataSchema.optional(),
  heardAbout: signupSourceInputSchema.optional(),
})

/** Input for the canonical atomic workspace creation service. */
export type WorkspaceCreationInput = z.infer<typeof workspaceCreationInputSchema>

/** Actual membership at the creation/replay transaction's authorization point. */
export const workspaceCreationMemberSchema = z.strictObject({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  role: z.string().min(1),
  createdAt: z.iso.datetime(),
})

/** Validated atomic creation result, shared by the tRPC and Better Auth callers. */
export const workspaceCreationResultSchema = z.strictObject({
  organization: z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    logo: z.string().nullable(),
    metadata: workspaceCreationMetadataSchema.nullable(),
    createdAt: z.iso.datetime(),
  }),
  creationMember: workspaceCreationMemberSchema,
  settings: z.strictObject({
    organizationId: z.string(),
    description: z.string().nullable(),
    locale: z.string(),
    timeZone: z.string(),
    defaultPublishTime: z.string(),
    aiAgentEnabled: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  }),
})

/** Public creation result; provider or session credentials are never included. */
export type WorkspaceCreationResult = z.infer<typeof workspaceCreationResultSchema>
