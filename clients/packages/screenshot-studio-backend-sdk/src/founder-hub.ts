import { z } from 'zod'

const identitySchema = z.object({
  emailVerified: z.boolean(),
  createdAt: z.iso.datetime(),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    name: z.string(),
    image: z.string().nullable(),
  }),
  accountUserId: z.uuid(),
})

const memberSchema = identitySchema.extend({
  role: z.string(),
  deniedPermissions: z.array(z.string()),
})

/** Live identity, grants, and immutable library mappings resolved by the Shots backend. */
export const founderHubSessionSchema = identitySchema.extend({
  revision: z.string().regex(/^\d+$/),
  sessionId: z.string().min(1),
  expiresAt: z.iso.datetime(),
  workspaces: z.array(
    z.object({
      organizationId: z.string().min(1),
      workspaceId: z.uuid(),
      ownerUserId: z.uuid(),
      owner: memberSchema,
      members: z.array(memberSchema),
      name: z.string(),
      role: z.string(),
      deniedPermissions: z.array(z.string()),
      features: z.record(z.string(), z.boolean()),
    })
  ),
})

/** Identity and entitlement hints used while the OAuth issuer signs a token. */
export const founderHubProfileSchema = founderHubSessionSchema.omit({
  sessionId: true,
  expiresAt: true,
})

/** Live native session and OAuth grant authorization without a workspace roster. */
export const founderHubAuthorizationSchema = founderHubSessionSchema
  .pick({
    sessionId: true,
    expiresAt: true,
  })
  .extend({ userId: z.string().min(1) })

/** Supported scalar values; null in a patch resets a setting to its default. */
export const founderHubSettingValueSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.string().max(262144),
])

/** The Shots-owned catalog used by both the web settings experience and desktop cache. */
export const founderHubSettingDefinitionSchema = z.object({
  type: z.enum(['boolean', 'number', 'string']),
  scope: z.enum(['account', 'device']),
  section: z.string(),
  label: z.string(),
  default: founderHubSettingValueSchema.optional(),
  format: z.enum(['string-array', 'json-array']).optional(),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  readOnly: z.boolean().optional(),
})

/** A private account or device configuration and its optimistic concurrency version. */
export const founderHubSettingsProfileSchema = z.object({
  deviceId: z.string().max(160),
  deviceName: z.string().max(200),
  values: z.record(z.string(), founderHubSettingValueSchema),
  version: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
})

/** All settings profiles owned by the signed-in person. */
export const founderHubSettingsSchema = z.object({
  account: z.object({
    workspaces: z.array(
      founderHubSessionSchema.shape.workspaces.element.pick({ name: true, features: true })
    ),
  }),
  catalog: z.record(z.string(), founderHubSettingDefinitionSchema),
  profiles: z.array(founderHubSettingsProfileSchema),
})

/** A scoped partial update; the required version prevents lost edits. */
export const founderHubSettingsUpdateSchema = z
  .object({
    deviceId: z.string().regex(/^(?:[a-zA-Z0-9_-]{1,160})?$/),
    deviceName: z.string().max(200),
    baseVersion: z.number().int().nonnegative(),
    values: z.record(z.string().max(160), founderHubSettingValueSchema.nullable()),
  })
  .strict()
