import { z } from 'zod'
import { AI_INSTRUCTIONS_MAX, aiModelDefaultsSchema } from '@/lib/ai/models/tiers'
import { organizationRoles } from '@/lib/auth/permissions'
import { workspaceCreateSchema, workspaceNameSchema, workspaceSlugSchema } from './input-schemas'

const localeSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .refine((value) => {
    try {
      return Intl.getCanonicalLocales(value).length === 1
    } catch {
      return false
    }
  }, 'Enter a valid locale.')

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: value })
      return true
    } catch {
      return false
    }
  }, 'Enter a valid IANA timezone.')

const logoSchema = z
  .string()
  .trim()
  .url()
  .max(2_000)
  .refine((value) => new URL(value).protocol === 'https:', 'Use an HTTPS logo URL.')

export const workspaceUpdateSchema = z.object({
  /** The AI kill switch; the backend lets only owners and admins change it. */
  aiAgentEnabled: z.boolean().optional(),
  releaseReadinessEnabled: z.boolean().optional(),
  defaultPublishTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM in 24-hour time.')
    .optional(),
  description: z.string().trim().max(1_000).nullable().optional(),
  locale: localeSchema.optional(),
  logo: logoSchema.nullable().optional(),
  name: workspaceNameSchema,
  slug: workspaceSlugSchema,
  timeZone: timeZoneSchema.optional(),
})

/** Core organization fields accepted by Better Auth's compatibility routes. */
export const workspaceOrganizationPatchSchema = workspaceUpdateSchema
  .pick({ logo: true, name: true, slug: true })
  .partial()

export { workspaceCreateSchema }

export const workspaceMemberIdSchema = z.object({ memberId: z.string().min(1).max(128) })

export const workspaceInvitationIdSchema = z.object({ invitationId: z.string().min(1).max(128) })

export const workspaceInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(organizationRoles.filter((role) => role !== 'owner')),
})

export const workspaceRoleChangeSchema = workspaceMemberIdSchema.extend({
  role: z.enum(organizationRoles.filter((role) => role !== 'owner')),
})

export const workspaceTransferOwnershipSchema = workspaceMemberIdSchema

export const workspaceDeleteSchema = z.object({
  confirmation: z.string().trim().min(2).max(100),
})

const aiProviderApiKeySchema = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || /^[\x21-\x7e]{16,512}$/.test(value),
    'Enter a valid OpenRouter API key (16–512 characters, no spaces).'
  )
  .nullable()
  .optional()

export const workspaceAiSettingsUpdateSchema = z.object({
  aiAgentEnabled: z.boolean().optional(),
  aiInstructions: z.string().trim().max(AI_INSTRUCTIONS_MAX).nullable().optional(),
  aiModelDefaults: aiModelDefaultsSchema.optional(),
  aiProviderApiKey: aiProviderApiKeySchema,
})

export const workspacePublishingSettingsUpdateSchema = z
  .object({
    processVideosOnServer: z.boolean().optional(),
    weeklyPostingGoal: z.number().int().min(1).max(1000).nullable().optional(),
  })
  .refine(
    (value) => value.weeklyPostingGoal !== undefined || value.processVideosOnServer !== undefined,
    'Choose a publishing setting to update.'
  )

export type WorkspaceAiSettingsUpdateInput = z.infer<typeof workspaceAiSettingsUpdateSchema>
export type WorkspacePublishingSettingsUpdateInput = z.infer<
  typeof workspacePublishingSettingsUpdateSchema
>

export type WorkspaceCreateInput = z.infer<typeof workspaceCreateSchema>
export type WorkspaceInviteInput = z.infer<typeof workspaceInviteSchema>
export type WorkspaceUpdateInput = z.infer<typeof workspaceUpdateSchema>
