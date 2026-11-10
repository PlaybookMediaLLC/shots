import { z } from 'zod'

/** Original personal summary-template content, including empty drafts. */
export const founderHubTemplateContentSchema = z
  .object({
    title: z.string().max(1000),
    description: z.string().max(262144),
    category: z.string().max(200),
    icon: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('icon'),
        value: z.string().min(1).max(100),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      }),
      z.object({ type: z.literal('emoji'), value: z.string().min(1).max(100) }),
    ]),
    targets: z.array(z.string().max(1000)).max(1000),
    sections: z
      .array(z.object({ title: z.string().max(1000), description: z.string().max(262144) }))
      .max(1000),
  })
  .strict()

/** A versioned template; updatedAt changes only when summary content changes. */
export const founderHubTemplateSchema = founderHubTemplateContentSchema.extend({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
  version: z.number().int().positive(),
  pinned: z.boolean(),
  pinOrder: z.number().int().nonnegative().nullable(),
  seeded: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
})

/** Cursor-based reads keep the private library bounded per response. */
export const founderHubTemplateQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{0,160}$/)
    .default(''),
  includeDeleted: z.enum(['true', 'false']).default('false'),
  revision: z
    .string()
    .regex(/^[0-9]{0,20}$/)
    .default(''),
})

/** Tombstones are included only when the cache explicitly requests them. */
export const founderHubTemplatePageSchema = z.object({
  items: z.array(founderHubTemplateSchema),
  nextCursor: z.string(),
  revision: z.string().regex(/^[0-9]{1,20}$/),
  unchanged: z.boolean(),
})

/** A conditional create, edit, favorite or deletion; legacy timestamps require native authorization. */
export const founderHubTemplateUpdateSchema = z
  .object({
    baseVersion: z.number().int().nonnegative(),
    content: founderHubTemplateContentSchema.optional(),
    pinned: z.boolean().optional(),
    deleted: z.boolean().optional(),
    importedUpdatedAt: z.iso.datetime().optional(),
  })
  .strict()
  .refine(
    (value) => value.content !== undefined || value.pinned !== undefined || value.deleted === true,
    'No template change supplied'
  )
