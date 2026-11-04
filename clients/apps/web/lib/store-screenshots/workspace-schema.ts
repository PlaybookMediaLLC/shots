import { z } from 'zod'
import { storeGroupSchema } from '@/lib/creative-sets/store-schema'
import { creativeSetRevisionSchema } from '@/lib/creative-sets/schema'
import { idSchema } from '@/lib/store-screenshots/document/schema'

/**
 * The `storeProject` API's inputs. A store screenshot project saved to the
 * workspace is a creative set of kind `store` holding one store group; it is
 * named by its local project id on every device.
 */

/** Input naming one saved store project by its local project id. */
export const storeProjectRefInputSchema = z.object({ projectId: idSchema })

/** Input of `storeProject.list`. */
export const storeProjectListInputSchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})
/** One of {@link storeProjectListInputSchema}. */
export type StoreProjectListInput = z.infer<typeof storeProjectListInputSchema>

/** Input of `storeProject.create`: the project's group, every image already uploaded. */
export const storeProjectCreateInputSchema = storeProjectRefInputSchema.extend({
  document: storeGroupSchema,
})
/** One of {@link storeProjectCreateInputSchema}. */
export type StoreProjectCreateInput = z.infer<typeof storeProjectCreateInputSchema>

/** Input of `storeProject.updateDocument`: a write based on the revision it started from. */
export const storeProjectDocumentInputSchema = storeProjectCreateInputSchema.extend({
  baseRevision: creativeSetRevisionSchema,
})
/** One of {@link storeProjectDocumentInputSchema}. */
export type StoreProjectDocumentInput = z.infer<typeof storeProjectDocumentInputSchema>
