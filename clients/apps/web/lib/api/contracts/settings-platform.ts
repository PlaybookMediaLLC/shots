import { z } from 'zod'
import type {
  AccountDeletionStatus,
  ExperimentState,
  UserPreferences,
} from 'screenshot-studio-backend-sdk'
import { defineContract, mirrors } from '@/lib/api/contract'

/**
 * The settings platform (RFC 024): a person's preferences, experiments and
 * account deletion. Social sets are in `social-sets.ts` and outbound webhooks
 * in `outbound-webhooks.ts`. Each schema mirrors the backend SDK's type, so
 * the Go contract and this one cannot drift.
 */

/** An ISO 8601 instant, as the backend wrote it. */
export const isoInstantSchema = z.string()

/** Light, dark, or the operating system's choice. */
export const themeSchema = z.enum(['light', 'dark', 'system'])

/** An optional personal accent; empty uses the standard palette. */
export const accentColorSchema = z.union([z.literal(''), z.string().regex(/^#[0-9a-fA-F]{6}$/)])

/** How the desktop navigation shows. */
export const navigationLayoutSchema = z.enum(['compact', 'dynamic', 'expanded'])

/** The first day of a calendar week. */
export const weekStartSchema = z.enum(['monday', 'sunday'])

/** The clock times read on; `auto` follows the browser locale. */
export const timeFormatSchema = z.enum(['auto', '12h', '24h'])

/** The direction text runs in the editor. */
export const textDirectionSchema = z.enum(['ltr', 'rtl'])

/** A person's preferences. */
export const userPreferencesSchema = mirrors<UserPreferences>()(
  z.object({
    accentColor: accentColorSchema,
    developerMode: z.boolean(),
    dismissedTips: z.array(z.string()),
    emailNotifications: z.boolean(),
    experiments: z.record(z.string(), z.boolean()),
    navigation: navigationLayoutSchema,
    showScrollbars: z.boolean(),
    textDirection: textDirectionSchema,
    theme: themeSchema,
    timeFormat: timeFormatSchema,
    timeZone: z.string().nullable(),
    updatedAt: isoInstantSchema.nullable(),
    version: z.number().int(),
    weekStart: weekStartSchema,
  })
)

/** A help tip's ID. */
export const helpTipIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

/** A preferences save: only the fields set change. */
export const userPreferencesUpdateSchema = z
  .object({
    accentColor: accentColorSchema.optional(),
    baseVersion: z.number().int().min(1).optional(),
    developerMode: z.boolean().optional(),
    dismissTip: helpTipIdSchema.optional(),
    emailNotifications: z.boolean().optional(),
    experiments: z.record(z.string().max(64), z.boolean()).optional(),
    navigation: navigationLayoutSchema.optional(),
    resetTips: z.boolean().optional(),
    showScrollbars: z.boolean().optional(),
    textDirection: textDirectionSchema.optional(),
    theme: themeSchema.optional(),
    timeFormat: timeFormatSchema.optional(),
    /** An IANA zone such as `Europe/Paris`, or an empty string to follow the browser. */
    timeZone: z.string().max(64).optional(),
    weekStart: weekStartSchema.optional(),
  })
  .strict()

/** `GET /api/v1/me/preferences` */
export const getUserPreferencesContract = defineContract({
  method: 'GET',
  name: 'me.preferences',
  output: userPreferencesSchema,
  path: '/api/v1/me/preferences',
  summary: 'Read your preferences',
})

/** `PATCH /api/v1/me/preferences` */
export const updateUserPreferencesContract = defineContract({
  body: userPreferencesUpdateSchema,
  method: 'PATCH',
  name: 'me.preferences-update',
  output: userPreferencesSchema,
  path: '/api/v1/me/preferences',
  summary: 'Save your preferences',
})

/** An experiment as you see it in this workspace. */
export const experimentStateSchema = mirrors<ExperimentState>()(
  z.object({
    dependencies: z.array(z.string()),
    description: z.string(),
    disabledByAdmin: z.boolean(),
    enabled: z.boolean(),
    enforcement: z.string(),
    entitled: z.boolean(),
    entitlement: z.string(),
    id: z.string(),
    minAppVersion: z.string(),
    name: z.string(),
    optedIn: z.boolean(),
    status: z.enum(['experimental', 'available', 'promoted', 'unavailable']),
    userEditable: z.boolean(),
  })
)

/** The experiment registry, evaluated for you. */
export const experimentListSchema = z.object({ items: z.array(experimentStateSchema) })

/** `GET /api/v1/experiments` */
export const listExperimentsContract = defineContract({
  method: 'GET',
  name: 'experiments.list',
  output: experimentListSchema,
  path: '/api/v1/experiments',
  summary: 'List experiments',
})

/** Path parameters naming one experiment. */
export const experimentParamsSchema = z.object({ id: z.string().regex(/^[a-z0-9-]{1,64}$/) })

/** `PUT /api/v1/experiments/{id}/workspace` */
export const setWorkspaceExperimentContract = defineContract({
  body: z.object({ disabled: z.boolean() }).strict(),
  method: 'PUT',
  name: 'experiments.workspace',
  output: experimentListSchema,
  params: experimentParamsSchema,
  path: '/api/v1/experiments/{id}/workspace',
  summary: 'Turn an experiment off, or back on, for the workspace',
})

/** Your open account deletion request and what blocks one. */
export const accountDeletionStatusSchema = mirrors<AccountDeletionStatus>()(
  z.object({
    blockers: z.array(
      z.object({
        code: z.enum(['owns_workspace', 'shared_attachments']),
        message: z.string(),
        workspaceId: z.string(),
        workspaceName: z.string(),
      })
    ),
    request: z
      .object({
        executeAfter: isoInstantSchema,
        id: z.string(),
        requestedAt: isoInstantSchema,
        status: z.enum(['REQUESTED', 'PROCESSING', 'CANCELLED', 'COMPLETED']),
      })
      .nullable(),
  })
)

/** `GET /api/v1/me/account-deletion` */
export const getAccountDeletionContract = defineContract({
  method: 'GET',
  name: 'me.account-deletion',
  output: accountDeletionStatusSchema,
  path: '/api/v1/me/account-deletion',
  summary: 'Read your account deletion request',
})

/** `POST /api/v1/me/account-deletion` */
export const requestAccountDeletionContract = defineContract({
  body: z.object({ confirmation: z.string().min(1).max(320) }).strict(),
  method: 'POST',
  name: 'me.account-deletion-request',
  output: accountDeletionStatusSchema,
  path: '/api/v1/me/account-deletion',
  status: 202,
  summary: 'Request deletion of your account',
})

/** `DELETE /api/v1/me/account-deletion` */
export const cancelAccountDeletionContract = defineContract({
  method: 'DELETE',
  name: 'me.account-deletion-cancel',
  output: accountDeletionStatusSchema,
  path: '/api/v1/me/account-deletion',
  summary: 'Cancel your account deletion request',
})
