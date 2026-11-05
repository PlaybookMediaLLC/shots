import { z } from 'zod'

const idSchema = z.string().min(1).max(64)
const hostSchema = z.string().min(1).max(253)
const pathSchema = z.string().trim().min(1).max(256)
const selectorSchema = z.string().trim().min(1).max(200)
const VIEWPORT_LIMITS = 'Use a viewport from 320×320 up to 1920×1080.'

/** Where a connected app runs; deployment captures match on it. */
export const captureEnvironmentSchema = z.enum(['production', 'staging', 'demo', 'development'])

/** The app to sign in to. The Go validator decides whether the hosts and origin are safe. */
export const captureConnectionInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  sourceAppId: idSchema.optional(),
  environment: captureEnvironmentSchema,
  origin: z.string().trim().min(1).max(2048),
  hosts: z
    .array(hostSchema)
    .min(1, 'Approve at least one host.')
    .max(10, 'Approve at most 10 hosts.'),
  loginHosts: z.array(hostSchema).max(10, 'Approve at most 10 sign-in hosts.'),
  protectedPath: pathSchema,
  identitySelector: selectorSchema,
  expectedAccount: z.string().trim().min(1).max(200),
})

/** A connection and whether its stored session can still be used; no session material. */
export const captureConnectionSchema = captureConnectionInputSchema.extend({
  id: idSchema,
  sourceAppId: z.string().nullable(),
  status: z.enum(['CONNECTING', 'READY', 'NEEDS_AUTH', 'REVOKED']),
  generation: z.number().int(),
  validatedAt: z.string().nullable(),
  stateExpiresAt: z.string().nullable(),
  connectPhase: z.string().nullable(),
  failureCode: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/**
 * The sign-in browser's one-time link. It is a bearer credential, so https only
 * before it reaches an href, and a failed parse never repeats the value.
 */
export const captureConnectStartSchema = z.object({
  intentId: z.string().min(1).max(128),
  liveViewUrl: z.url({ protocol: /^https$/ }),
  expiresAt: z.string(),
})

/** "I signed in" for one exact sign-in; it proves nothing until a worker restores the session. */
export const captureConnectFinishSchema = z.object({
  id: idSchema,
  intentId: captureConnectStartSchema.shape.intentId,
})

/** A bounded recipe shape. What may actually run is decided by the Go validator. */
export const captureRecipeDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  viewport: z.object({
    width: z.number().int().min(320, VIEWPORT_LIMITS).max(1920, VIEWPORT_LIMITS),
    height: z.number().int().min(320, VIEWPORT_LIMITS).max(1080, VIEWPORT_LIMITS),
  }),
  steps: z
    .array(
      z.object({
        kind: z.enum(['NAVIGATE', 'WAIT_FOR', 'SELECT_TAB']),
        path: pathSchema.optional(),
        selector: selectorSchema.optional(),
        timeoutMs: z.number().int().min(0).max(30_000).optional(),
      })
    )
    .min(1)
    .max(10),
  markers: z.array(selectorSchema).min(1).max(20),
  forbidden: z.array(selectorSchema).max(20).optional(),
  masks: z.array(selectorSchema).max(20, 'Use at most 20 masks.').optional(),
  version: z
    .object({ path: pathSchema.optional(), selector: selectorSchema.optional() })
    .optional(),
  allowedPostPaths: z.array(pathSchema).max(5).optional(),
})

/** A new version of a screen's capture; it runs only as a test until activated. */
export const captureRecipeInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  surfaceId: idSchema,
  connectionId: idSchema,
  definition: captureRecipeDefinitionSchema,
})

/** One immutable recipe version. */
export const captureRecipeSchema = z.object({
  id: idSchema,
  name: z.string(),
  version: z.number().int(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
  surfaceId: z.string().nullable(),
  connectionId: z.string().nullable(),
  hash: z.string().nullable(),
  definition: captureRecipeDefinitionSchema,
  testedAt: z.string().nullable(),
  createdAt: z.string(),
})

/** A capture job's status: IDs and safe codes, no browser state. */
export const captureJobSchema = z.object({
  id: idSchema,
  recipeId: z.string(),
  recipeVersion: z.number().int(),
  kind: z.enum(['test', 'manual', 'deployment']),
  phase: z.enum([
    'QUEUED',
    'WAITING_DEPLOYMENT',
    'RUNNING',
    'NEEDS_AUTH',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
  ]),
  surfaceId: z.string().nullable(),
  connectionId: z.string().nullable(),
  deploymentEventId: z.string().nullable(),
  expectedRevision: z.string().nullable(),
  surfaceCaptureId: z.string().nullable(),
  assetId: z.string().nullable(),
  failureCode: z.string().nullable(),
  attempts: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** Everything a member may read about this workspace's authenticated capture. */
export const captureOverviewSchema = z.object({
  available: z.boolean(),
  connections: z.array(captureConnectionSchema),
  recipes: z.array(captureRecipeSchema),
  jobs: z.array(captureJobSchema),
})

/** One connection, recipe or job by its ID; tenant scope always comes from the session. */
export const captureIdentitySchema = z.object({ id: idSchema })

/** A connection without session material. */
export type CaptureConnection = z.infer<typeof captureConnectionSchema>
/** The app to sign in to. */
export type CaptureConnectionInput = z.infer<typeof captureConnectionInputSchema>
/** The one-time sign-in link and the intent that finishes it. */
export type CaptureConnectStart = z.infer<typeof captureConnectStartSchema>
/** One immutable recipe version. */
export type CaptureRecipe = z.infer<typeof captureRecipeSchema>
/** A bounded recipe shape. */
export type CaptureRecipeDefinition = z.infer<typeof captureRecipeDefinitionSchema>
/** A new version of a screen's capture. */
export type CaptureRecipeInput = z.infer<typeof captureRecipeInputSchema>
/** A capture job's status. */
export type CaptureJob = z.infer<typeof captureJobSchema>
/** The workspace's connections, recipes and recent jobs. */
export type CaptureOverview = z.infer<typeof captureOverviewSchema>
