import { z } from 'zod'

/** Device permissions remain OS grants, reported privately to the signed-in owner. */
export const founderHubPermissionSchema = z.enum([
  'microphone',
  'systemAudio',
  'accessibility',
  'calendar',
  'screenRecording',
  'reminders',
  'contacts',
  'inputMonitoring',
])
/** Non-secret capabilities and native UI choices reported by a connected desktop. */
export const founderHubDeviceReportSchema = z
  .object({
    platform: z.enum(['macos', 'windows', 'linux']),
    version: z.string().max(100),
    identifier: z.string().max(200),
    locale: z.string().max(100),
    timezone: z.string().max(100),
    appStore: z.boolean(),
    lockAvailable: z.boolean(),
    homeDirectory: z.string().max(4096),
    downloadsDirectory: z.string().max(4096),
    microphones: z.array(z.string().max(1000)).max(256),
    installedApps: z
      .array(z.object({ id: z.string().max(1000), name: z.string().max(1000) }).strict())
      .max(10000),
    defaultIgnoredApps: z.array(z.string().max(1000)).max(1000),
    permissions: z.partialRecord(
      founderHubPermissionSchema,
      z.enum(['authorized', 'denied', 'neverRequested', 'unknown'])
    ),
    supportsCloudsyncSettings: z.boolean().optional(),
    autoFormatKey: z
      .string()
      .regex(/^[A-Za-z0-9+/]{87}=$/)
      .optional(),
  })
  .strict()
/** One computer associated with the authenticated person. */
export const founderHubDeviceSchema = z.object({
  deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
  name: z.string().max(200),
  report: founderHubDeviceReportSchema,
  reportedAt: z.iso.datetime(),
})
/** Heartbeat and capability snapshot from the native gateway. */
export const founderHubDeviceReportInputSchema = founderHubDeviceSchema.omit({ reportedAt: true })
/** Sanitized local CloudSync health returned by the desktop's bounded command channel. */
export const founderHubCloudsyncStatusSchema = z
  .object({
    cloudsync_enabled: z.boolean(),
    configured: z.boolean(),
    running: z.boolean(),
    activity_paused: z.boolean(),
    deferred_for_capture: z.boolean(),
    last_sync_at_ms: z.number().int().min(0).max(8_640_000_000_000_000).nullable(),
    has_unsent_changes: z.boolean().nullable(),
    last_error_kind: z.enum(['transient', 'auth', 'fatal']).nullable(),
    consecutive_failures: z.number().int().nonnegative(),
    recovery_pending: z.boolean(),
    recovery_delayed: z.boolean(),
    conflicted_notes: z.number().int().nonnegative(),
    pending_update_records: z.number().int().nonnegative(),
    too_large_records: z.number().int().nonnegative(),
  })
  .strict()
/** Only these explicit settings actions can be requested; no paths, shell text or arbitrary plugin calls. */
export const founderHubDeviceCommandInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      deviceId: founderHubDeviceSchema.shape.deviceId,
      kind: z.enum(['auto-format', 'dictation-status']),
      argument: z.string().min(1).max(201000),
    })
    .strict(),
  z
    .object({
      deviceId: founderHubDeviceSchema.shape.deviceId,
      kind: z.enum([
        'show-release-notes',
        'dictation-retry',
        'dictation-cancel',
        'show-dictation-shortcut',
      ]),
      argument: z.literal(''),
    })
    .strict(),
  z
    .object({
      deviceId: founderHubDeviceSchema.shape.deviceId,
      kind: z.enum(['cloudsync-status', 'cloudsync-now']),
      argument: z.literal(''),
    })
    .strict(),
  z
    .object({
      deviceId: founderHubDeviceSchema.shape.deviceId,
      kind: z.literal('choose-export-directory'),
      argument: z.literal(''),
    })
    .strict(),
  z
    .object({
      deviceId: founderHubDeviceSchema.shape.deviceId,
      kind: z.literal('open-export-directory'),
      argument: z.literal(''),
    })
    .strict(),
  z
    .object({
      deviceId: founderHubDeviceSchema.shape.deviceId,
      kind: z.literal('request-permission'),
      argument: founderHubPermissionSchema,
    })
    .strict(),
  z
    .object({
      deviceId: founderHubDeviceSchema.shape.deviceId,
      kind: z.literal('open-permission'),
      argument: founderHubPermissionSchema,
    })
    .strict(),
  z
    .object({
      deviceId: founderHubDeviceSchema.shape.deviceId,
      kind: z.literal('set-lock'),
      argument: z.enum(['true', 'false']),
    })
    .strict(),
  z
    .object({
      deviceId: founderHubDeviceSchema.shape.deviceId,
      kind: z.literal('preview-sound'),
      argument: z.enum(['ready', 'success', 'chime', 'sparkle', 'bloom']),
    })
    .strict(),
])
/** One expiring native settings request and its execution result. */
export const founderHubDeviceCommandSchema = z.union(
  founderHubDeviceCommandInputSchema.options.map((option) =>
    option.extend({
      id: z.string().min(1).max(160),
      status: z.enum(['pending', 'running', 'succeeded', 'failed', 'expired']),
      error: z.string().max(1000),
      result: z.string().max(201000).default(''),
      expiresAt: z.iso.datetime(),
    })
  )
)
/** The target desktop acknowledges a claimed request once execution completes. */
export const founderHubDeviceCommandResultSchema = z
  .object({
    deviceId: founderHubDeviceSchema.shape.deviceId,
    status: z.enum(['succeeded', 'failed']),
    error: z.string().max(1000),
    result: z.string().max(201000).default(''),
  })
  .strict()
