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
  /** Empty proves the account from its text in the app's header or navigation. */
  identitySelector: z.union([z.literal(''), selectorSchema]),
  expectedAccount: z.string().trim().min(1).max(200),
  /** Optional customer-hosted HTTPS endpoint that returns short-lived demo session state. */
  bootstrapUrl: z.string().trim().max(2048).optional(),
  /** Optional HMAC signing secret (>=16 chars) paired with `bootstrapUrl`. */
  bootstrapSecret: z.string().trim().max(512).optional(),
})

/**
 * A new connection. With `assignTestEmail` Shots makes the expected account a
 * new test email address that can receive sign-in emails (RFC 007A), so the
 * expected account stays empty.
 */
export const captureConnectionCreateSchema = captureConnectionInputSchema
  .extend({
    expectedAccount: z.string().trim().max(200),
    assignTestEmail: z.boolean().optional(),
  })
  .superRefine((input, context) => {
    if (input.assignTestEmail && input.expectedAccount) {
      context.addIssue({
        code: 'custom',
        message: 'Leave the expected account empty: Shots assigns the test email address.',
        path: ['expectedAccount'],
      })
    }
    if (!input.assignTestEmail && !input.expectedAccount) {
      context.addIssue({
        code: 'custom',
        message: 'Say what the signed-in account shows.',
        path: ['expectedAccount'],
      })
    }
  })

/** A connection and whether its stored session can still be used; no session material. */
export const captureConnectionSchema = captureConnectionInputSchema
  .omit({ bootstrapSecret: true })
  .extend({
    id: idSchema,
    sourceAppId: z.string().nullable(),
    status: z.enum(['CONNECTING', 'READY', 'NEEDS_AUTH', 'REVOKED']),
    generation: z.number().int(),
    validatedAt: z.string().nullable(),
    stateExpiresAt: z.string().nullable(),
    connectPhase: z.string().nullable(),
    failureCode: z.string().nullable(),
    discoveredRoutes: z.array(z.object({ path: z.string(), label: z.string() })).optional(),
    bootstrapUrl: z.string().nullable().optional(),
    hasBootstrap: z.boolean().optional(),
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
    /** 2 captures at twice the pixel density; omitted is 1. */
    scale: z.union([z.literal(1), z.literal(2)]).optional(),
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
  /** Selectors masked when present without failing if absent on a navigated route. */
  optionalMasks: z.array(selectorSchema).max(20).optional(),
  /** Mask appearance: solid black boxes (default) or CSS blur. */
  maskStyle: z.enum(['solid', 'blur']).optional(),
  /** Emulate light or dark prefers-color-scheme on the captured page. */
  colorScheme: z.enum(['light', 'dark']).optional(),
  /** Verify the captured screenshot visually before committing it to campaigns. */
  verifyWithVision: z.boolean().optional(),
  /** Capture 1 to 4 ordered frames (before -> interaction -> final) for walkthrough carousels. */
  sequenceShots: z.number().int().min(1).max(4).optional(),
  version: z
    .object({ path: pathSchema.optional(), selector: selectorSchema.optional() })
    .optional(),
  allowedPostPaths: z.array(pathSchema).max(5).optional(),
  /** `marker` makes the image the first marker and a small margin, not the whole viewport. */
  crop: z.enum(['marker']).optional(),
  navigation: z
    .object({
      objective: z.string().trim().min(1).max(1000),
      maxSteps: z.number().int().min(1).max(6),
      creditLimit: z.number().int().min(1).max(20),
      /** Attach Set-of-Mark annotated viewport screenshots so AI sees controls visually. */
      useVision: z.boolean().optional(),
      /** Allow read-only typing into safe search and filter inputs. */
      allowSearchFill: z.boolean().optional(),
    })
    .optional(),
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
  kind: z.enum(['test', 'manual', 'agent', 'deployment']),
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
  /** What a release-matched capture was steered to show; untrusted text from release notes. */
  releaseChange: z.string().nullable().optional(),
  /** The newest attempt's AI path: control kinds and paths only. */
  navigationActions: z.array(z.object({ kind: z.string(), path: z.string() })).optional(),
  /** Normalized bounding box (0-1 fractions) of the captured marker element. */
  focusBox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
  /** Ordered asset IDs for multi-shot sequence captures (before -> interaction -> final). */
  sequenceAssetIds: z.array(idSchema).optional(),
})

/** Plain-English input for zero-config AI recipe authoring or 1-click auto-capture. */
export const proposeCaptureRecipeInputSchema = z.object({
  connectionId: idSchema,
  surfaceId: idSchema,
  prompt: z.string().trim().min(1, 'Describe what you want captured.').max(600),
  sequenceShots: z.number().int().min(1).max(4).optional(),
})

/** A validated, ready-to-save AI capture recipe proposed from a plain-English prompt. */
export const proposedCaptureRecipeSchema = z.object({
  name: z.string().min(1).max(160),
  definition: captureRecipeDefinitionSchema,
  reasoning: z.string(),
})

/** Result of 1-click zero-config AI capture: the created recipe and queued job. */
export const autoCaptureResultSchema = z.object({
  recipe: captureRecipeSchema,
  job: captureJobSchema,
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

/**
 * A typed first-factor email sign-in: fixed selectors and paths, never a
 * script. The Go validator is the authority on what may run.
 */
export const captureLoginRecipeSchema = z.object({
  schemaVersion: z.literal(1),
  method: z.enum(['MAGIC_LINK', 'EMAIL_CODE']),
  startPath: pathSchema,
  emailInput: selectorSchema,
  requestChallenge: selectorSchema,
  challengeConfirmation: selectorSchema.optional(),
  submitPaths: z.array(pathSchema).min(1).max(5),
  linkHosts: z.array(hostSchema).max(10).optional(),
  linkPaths: z.array(pathSchema).max(10).optional(),
  codeInput: selectorSchema.optional(),
  codeLength: z.number().int().min(4).max(10).optional(),
  submitCode: selectorSchema.optional(),
})

/** Where an email sign-in attempt is. No link, code, email, or browser ID. */
export const captureAuthAttemptSchema = z.object({
  id: idSchema,
  connectionId: idSchema,
  mode: z.enum(['TEST', 'AUTO_RECOVER']),
  state: z.enum([
    'ADMITTED',
    'BROWSER_STARTING',
    'CHALLENGE_REQUESTED',
    'WAITING_FOR_EMAIL',
    'EMAIL_MATCHED',
    'APPLYING_CHALLENGE',
    'VERIFYING',
    'COMMITTING',
    'SUCCEEDED',
    'FAILED',
    'EXPIRED',
    'CANCELLED',
    'HUMAN_REQUIRED',
  ]),
  startedAt: z.string(),
  deadlineAt: z.string(),
  emailRequestedAt: z.string().nullable(),
  emailReceivedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  failureCode: z.string().nullable(),
  safeMessage: z.string(),
})

/** A connection's email sign-in setup. The test address is shown on purpose. */
export const captureEmailAuthSchema = z.object({
  id: idSchema,
  connectionId: idSchema,
  method: z.enum(['MAGIC_LINK', 'EMAIL_CODE']),
  status: z.enum(['DRAFT', 'VERIFIED', 'PAUSED', 'REVOKED']),
  testEmail: z.string(),
  expectedSenders: z.array(z.string()),
  autoReconnect: z.boolean(),
  revision: z.number().int(),
  testedRevision: z.number().int().nullable(),
  recipeVersion: z.number().int().nullable(),
  recipe: captureLoginRecipeSchema.nullable(),
  lastTestedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastFailureCode: z.string().nullable(),
  approvedByUserId: z.string().nullable(),
  approvedAt: z.string().nullable(),
  autoReconnectAvailable: z.boolean(),
  latestAttempt: captureAuthAttemptSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** A new login recipe version for the revision the owner last saw. */
export const saveCaptureEmailAuthRecipeSchema = z.object({
  id: idSchema,
  expectedRevision: z.number().int().min(1),
  recipe: captureLoginRecipeSchema,
  expectedSenders: z
    .array(z.string().trim().min(1).max(254))
    .min(1, 'List the address or @domain the sign-in email comes from.')
    .max(10),
})

/** The owner's opt-in to automatic sign-in for one tested revision. */
export const enableCaptureEmailAuthSchema = z.object({
  id: idSchema,
  expectedRevision: z.number().int().min(1),
})

/** A connection without session material. */
export type CaptureConnection = z.infer<typeof captureConnectionSchema>
/** A new connection, optionally with a Shots test email address. */
export type CaptureConnectionCreate = z.infer<typeof captureConnectionCreateSchema>
/** A typed first-factor email sign-in. */
export type CaptureLoginRecipe = z.infer<typeof captureLoginRecipeSchema>
/** Where an email sign-in attempt is. */
export type CaptureAuthAttempt = z.infer<typeof captureAuthAttemptSchema>
/** A connection's email sign-in setup. */
export type CaptureEmailAuth = z.infer<typeof captureEmailAuthSchema>
/** A new login recipe version. */
export type SaveCaptureEmailAuthRecipe = z.infer<typeof saveCaptureEmailAuthRecipeSchema>
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
/** Plain-English input for zero-config AI capture authoring or 1-click auto-capture. */
export type ProposeCaptureRecipeInput = z.infer<typeof proposeCaptureRecipeInputSchema>
/** A validated, ready-to-save AI capture recipe proposed from a plain-English prompt. */
export type ProposedCaptureRecipe = z.infer<typeof proposedCaptureRecipeSchema>
/** Result of 1-click zero-config AI capture: the created recipe and queued job. */
export type AutoCaptureResult = z.infer<typeof autoCaptureResultSchema>
