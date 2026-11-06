import 'server-only'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { type BrandVoice, writeCopy } from '@/lib/ai/agents/captions'
import { critiqueDesign, proposeVariants, estimateVariantCredits } from '@/lib/ai/agents/editor-assist'
import { gridLinesRequestSchema, suggestGridLines } from '@/lib/ai/agents/grid-lines'
import { BackgroundGenerationError, generateBackground } from '@/lib/ai/images/background'
import { generateGridSlotImage, gridSlotRequestSchema } from '@/lib/ai/images/grid-slot'
import { backgroundRequestSchema } from '@/lib/ai/images/background-request'
import { withAiCredits } from '@/lib/ai/metering'
import { variantCountSchema } from '@/lib/ai/variants'
import { backendSDK, orNull } from '@/lib/backend/sdk'
import { captionChannelSchema } from '@/lib/captions/channels'
import { designDocumentSchema } from '@/lib/design/document'
import { getBrandProfile } from '@/lib/tenant/configuration'
import { draftChannelSchema, writeIdSchema } from '@/lib/write/document'
import { router } from '../init'
import { allowAiAction, isAiEnabled } from './launch'
import { organizationProcedure } from '../procedures'

/** Up to ~2 MB of base64 JPEG: a snapshot, never a full export. */
const snapshotSchema = z.string().max(2_800_000).nullable()

/**
 * The publishing identity's writing voice (RFC 024), or null when there is
 * no set or it cannot be read. A voice that does not load weakens the
 * captions; it must not stop them from being written.
 */
async function setVoice(
  access: Parameters<typeof backendSDK>[0],
  socialSetId: string,
  channel: string
) {
  try {
    return await orNull(backendSDK(access).getSocialSetWritingContext(socialSetId, channel))
  } catch {
    return null
  }
}

/** The workspace's brand voice; members who cannot read the profile write without it. */
async function brandVoice(
  access: Parameters<typeof getBrandProfile>[0]
): Promise<BrandVoice | null> {
  try {
    const profile = await getBrandProfile(access)
    if (!profile) return null
    const terms = z.array(z.string()).catch([]).parse(profile.prohibitedTerms)
    return {
      audience: profile.audience,
      ctaConventions: profile.ctaConventions,
      productDescription: profile.productDescription,
      prohibitedTerms: terms,
      tone: profile.tone,
    }
  } catch {
    return null
  }
}

export const editorAiRouter = router({
  /** Which in-editor AI features this environment and workspace can use. */
  status: organizationProcedure('artifact:read').query(async ({ ctx }) => {
    const enabled = await isAiEnabled(ctx.access)
    return { backgrounds: enabled, captions: enabled, copilot: enabled, variants: enabled }
  }),
  critique: organizationProcedure('artifact:edit')
    .input(z.object({ document: designDocumentSchema, snapshot: snapshotSchema }))
    .mutation(async ({ ctx, input }) => {
      await allowAiAction(ctx.access)
      return {
        suggestions: await withAiCredits(ctx.access, () =>
          critiqueDesign(input.document, input.snapshot)
        ),
      }
    }),
  /** Usage estimate, without running a model or spending credits. */
  variantEstimate: organizationProcedure('artifact:read')
    .input(z.object({ count: variantCountSchema, document: designDocumentSchema }))
    .query(({ input }) => estimateVariantCredits(input.document, input.count)),
  /** Complete, distinct versions of the design, as changes the browser applies to its own copy. */
  variants: organizationProcedure('artifact:edit')
    .input(
      z.object({
        count: variantCountSchema.default(4),
        document: designDocumentSchema,
        instruction: z.string().trim().max(300).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await allowAiAction(ctx.access)
      return {
        variants: await withAiCredits(ctx.access, () =>
          proposeVariants(input.document, { count: input.count, instruction: input.instruction })
        ),
      }
    }),
  /** Draw a background from a description and palette, stored as a workspace image. */
  generateBackground: organizationProcedure('artifact:edit')
    .input(backgroundRequestSchema)
    .mutation(async ({ ctx, input }) => {
      await allowAiAction(ctx.access)
      try {
        const image = await withAiCredits(ctx.access, () => generateBackground(input))
        const asset = await backendSDK(ctx.access).storeGeneratedAsset({
          body: image.body,
          classification: 'derived',
          contentType: 'image/webp',
          fileName: 'ai-background.webp',
          height: image.height,
          width: image.width,
        })
        return { assetId: asset.id, height: image.height, width: image.width }
      } catch (error) {
        if (error instanceof BackgroundGenerationError) {
          throw new TRPCError({ cause: error, code: 'BAD_REQUEST', message: error.message })
        }
        throw error
      }
    }),
  /** Draw the image of one grid video slot from its label, stored as a workspace image. */
  generateGridSlotImage: organizationProcedure('artifact:edit')
    .input(gridSlotRequestSchema)
    .mutation(async ({ ctx, input }) => {
      await allowAiAction(ctx.access)
      try {
        const image = await withAiCredits(ctx.access, () => generateGridSlotImage(input))
        const asset = await backendSDK(ctx.access).storeGeneratedAsset({
          body: image.body,
          classification: 'derived',
          contentType: 'image/webp',
          fileName: 'grid-image.webp',
          height: image.height,
          width: image.width,
        })
        return { assetId: asset.id }
      } catch (error) {
        if (error instanceof BackgroundGenerationError) {
          throw new TRPCError({ cause: error, code: 'BAD_REQUEST', message: error.message })
        }
        throw error
      }
    }),
  /** More captions or content items in the spirit of the ones a grid video batch has. */
  suggestGridLines: organizationProcedure('artifact:edit')
    .input(gridLinesRequestSchema)
    .mutation(async ({ ctx, input }) => {
      await allowAiAction(ctx.access)
      return { lines: await withAiCredits(ctx.access, () => suggestGridLines(input)) }
    }),
  /**
   * Alt text and platform-aware captions for the design, from a snapshot and
   * its text. With a social set, the captions are written in that identity's
   * voice (RFC 024) instead of the workspace brand voice alone, so the editor
   * and the composer's writing assistant sound like the same account.
   */
  captions: organizationProcedure('artifact:edit')
    .input(
      z.object({
        channels: z.array(captionChannelSchema).min(1).max(6),
        document: designDocumentSchema,
        notes: z.string().trim().max(1000).optional(),
        snapshot: z.string().min(1).max(2_800_000),
        /** The publishing identity the captions are written for. */
        socialSetId: writeIdSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await allowAiAction(ctx.access)
      const brand = await brandVoice(ctx.access)
      // The voice is read for the first requested channel the backend knows;
      // its platform guidance is the only per-channel part of the context.
      const channel = input.channels.find(
        (candidate) => draftChannelSchema.safeParse(candidate).success
      )
      const voice =
        input.socialSetId && channel ? await setVoice(ctx.access, input.socialSetId, channel) : null
      return withAiCredits(ctx.access, () =>
        writeCopy({
          brand,
          channels: input.channels,
          document: input.document,
          notes: input.notes,
          snapshotJpegBase64: input.snapshot,
          voice,
        })
      )
    }),
})
