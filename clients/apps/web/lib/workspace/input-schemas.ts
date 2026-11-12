import { z } from 'zod'
import {
  signupSourceInputSchema,
  workspaceNameInputSchema,
  workspaceNameSchema,
} from 'screenshot-studio-backend-sdk'

export { workspaceNameSchema }

export const workspaceSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers, and hyphens only.')
  .min(2)
  .max(100)

export const workspaceCreateSchema = z.object({
  name: workspaceNameInputSchema,
  slug: workspaceSlugSchema,
  idempotencyKey: z.uuid().optional(),
  keepCurrentActiveOrganization: z.boolean().optional(),
  timeZone: z
    .string()
    .max(100)
    .refine((zone) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: zone })
        return true
      } catch {
        return false
      }
    }, 'Choose a valid time zone.')
    .optional(),
  /** Where the creator heard about Shots; first onboarding asks, and the answer is optional. */
  heardAbout: signupSourceInputSchema.optional(),
})
