import 'server-only'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { writeCopy } from '@/lib/ai/agents/captions'
import {
  critiqueDesign,
  estimateVariantCredits,
  proposeVariants,
  type VariantBrand,
} from '@/lib/ai/agents/editor-assist'
import {
  gridLinesRequestSchema,
  overlayIdeasRequestSchema,
  suggestGridLines,
  suggestOverlayIdeas,
} from '@/lib/ai/agents/grid-lines'
import { BackgroundGenerationError, generateBackground } from '@/lib/ai/images/background'
import { generateGridSlotImage, gridSlotRequestSchema } from '@/lib/ai/images/grid-slot'
import { backgroundRequestSchema } from '@/lib/ai/images/background-request'
import { withAiCredits } from '@/lib/ai/metering'
import { variantCountSchema } from '@/lib/ai/variants'
import { backendSDK, orNull } from '@/lib/backend/sdk'
import { brandKitById, storedBrandKitSchema } from '@/lib/brand/kit'
import { captionChannelSchema } from '@/lib/captions/channels'
import { designDocumentSchema } from '@/lib/design/document'
import { listBrandKits } from '@/lib/tenant/configuration'
import { getWorkspaceVoice } from '@/lib/launch/store'
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

/**
 * The visual brand versions must stay within: the exact kit version the
 * design has applied, which is what it currently looks like. Each saved
 * version is its own row, so this looks the id up across every version
 * rather than only the latest of each name. The lookup is scoped to the
 * caller's workspace, so an id from elsewhere simply finds nothing, and a
 * kit the member cannot read leaves versions unconstrained rather than
 * failing the request.
 */
async function variantBrand(
  access: Parameters<typeof listBrandKits>[0],
  kitId: string | undefined
): Promise<VariantBrand | null> {
  if (!kitId) return null
  try {
    const stored = await listBrandKits(access)
    const kit = brandKitById(
      stored.flatMap((item) => {
        const parsed = storedBrandKitSchema.safeParse(item)
        return parsed.success ? [parsed.data] : []
      }),
      kitId
    )
    if (!kit) return null
    return {
      accent: kit.accent,
      background: kit.colors.background,
      bodyFont: kit.secondaryFont,
      foreground: kit.colors.foreground,
      headingFont: kit.primaryFont,
      name: kit.name,
      palette: kit.colors.palette,
      secondary: kit.colors.secondary,
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
        /** Keep every version inside this workspace brand kit's colours and fonts. */
        brandKitId: z.string().max(64).optional(),
        count: variantCountSchema.default(4),
        document: designDocumentSchema,
        instruction: z.string().trim().max(300).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await allowAiAction(ctx.access)
      const [brand, voice] = await Promise.all([
        variantBrand(ctx.access, input.brandKitId),
        getWorkspaceVoice(ctx.access),
      ])
      return {
        variants: await withAiCredits(ctx.access, () =>
          proposeVariants(input.document, {
            brand,
            count: input.count,
            instruction: input.instruction,
            voice,
          })
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
      const voice = await getWorkspaceVoice(ctx.access)
      return { lines: await withAiCredits(ctx.access, () => suggestGridLines(input, voice)) }
    }),
  /** Ideas for a UGC video's text from a product description: the caption assistant. */
  suggestOverlayIdeas: organizationProcedure('artifact:edit')
    .input(overlayIdeasRequestSchema)
    .mutation(async ({ ctx, input }) => {
      await allowAiAction(ctx.access)
      const voice = await getWorkspaceVoice(ctx.access)
      return {
        lines: await withAiCredits(ctx.access, () => suggestOverlayIdeas(input.description, voice)),
      }
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
      // With a set, its voice for each requested channel the backend knows:
      // platform guidance is the per-channel part, so each caption gets its
      // own. Without a set, the workspace voice: the same format, the brand's.
      const socialSetId = input.socialSetId
      const voices = socialSetId
        ? await Promise.all(
            input.channels
              .filter((candidate) => draftChannelSchema.safeParse(candidate).success)
              .map(
                async (channel) =>
                  [channel, await setVoice(ctx.access, socialSetId, channel)] as const
              )
          )
        : []
      const voice = voices.find(([, found]) => found)?.[1] ?? (await getWorkspaceVoice(ctx.access))
      const guidance = Object.fromEntries(
        voices.flatMap(([channel, found]) =>
          found?.platformGuidance ? [[channel, found.platformGuidance]] : []
        )
      )
      return withAiCredits(ctx.access, () =>
        writeCopy({
          channels: input.channels,
          guidance,
          document: input.document,
          notes: input.notes,
          snapshotJpegBase64: input.snapshot,
          voice,
        })
      )
    }),
})
