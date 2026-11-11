import 'server-only'

import { TRPCError } from '@trpc/server'
import { backendSDK } from '@/lib/backend/sdk'
import { workspaceRequestScopeSchema } from '@/lib/auth/request-scope'
import { refineTexts } from '@/lib/write/refine'
import { allowAiAction } from './launch'
import { accessAllows } from '@/lib/auth/permissions'
import {
  archiveBrandKit,
  createBrandKit,
  createSourceApp,
  getBrandProfile,
  listBrandKits,
  renameBrandKit,
  upsertBrandProfile,
} from '@/lib/tenant/configuration'
import {
  brandKitCreateSchema,
  brandProfileUpsertSchema,
  libraryArchiveSchema,
  libraryRenameSchema,
  sourceAppCreateSchema,
} from '@/lib/tenant/schemas'
import { getSourceWebhookSetup } from '@/lib/tenant/webhooks'
import { router } from '../init'
import { organizationProcedure, tenantProcedure } from '../procedures'

export const brandKitRouter = router({
  // Every member reads brand kits to apply them; managing them needs brand:manage.
  list: organizationProcedure('artifact:read').query(async ({ ctx }) => {
    const brandKits = await listBrandKits(ctx.access)
    return { brandKits, canManage: accessAllows(ctx.access, 'brand:manage') }
  }),
  create: organizationProcedure('brand:manage')
    .input(brandKitCreateSchema)
    .mutation(async ({ ctx, input }) => {
      const brandKit = await createBrandKit(ctx.access, input)
      return { brandKit }
    }),
  rename: organizationProcedure('brand:manage')
    .input(libraryRenameSchema)
    .mutation(async ({ ctx, input }) => ({
      brandKit: await renameBrandKit(ctx.access, input.id, input.name),
    })),
  archive: organizationProcedure('brand:manage')
    .input(libraryArchiveSchema)
    .mutation(({ ctx, input }) => archiveBrandKit(ctx.access, input.id)),
})

export const brandProfileRouter = router({
  /** Only the guidance that members inherit; profile management stays restricted. */
  defaults: organizationProcedure('artifact:read')
    .input(workspaceRequestScopeSchema.optional())
    .query(({ ctx, input }) => {
      if (
        input &&
        (input.userId !== ctx.access.principal.userId ||
          input.workspaceId !== ctx.access.organizationId)
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Your account or workspace changed. Reload this page to continue.',
        })
      }
      return backendSDK(ctx.access).getWritingDefaults()
    }),
  /** Preview unsaved voice settings without changing the profile or creating a draft. */
  preview: organizationProcedure('brand:manage')
    .input(brandProfileUpsertSchema)
    .mutation(async ({ ctx, input }) => {
      await allowAiAction(ctx.access)
      return refineTexts(
        ctx.access,
        {
          action: 'custom',
          channel: 'linkedin',
          limit: 3000,
          scope: 'post',
          prompt:
            'Write a representative social post from these product facts. Invent no claims. Use the supplied voice and call to action.',
          texts: [
            [input.tagline, input.productDescription, input.ctaConventions]
              .filter(Boolean)
              .join('\n\n'),
          ],
        },
        // The unsaved form as the one voice format, as the backend would merge it.
        {
          tone: input.tone,
          audience: input.audience,
          ctaConventions: input.ctaConventions ?? '',
          formatting: '',
          preferredStyles: input.preferredStyles,
          productDescription: input.productDescription,
          prohibitedPhrases: input.prohibitedTerms.map((term) =>
            typeof term === 'string' ? term : term.term
          ),
          socialHandles: input.socialHandles ?? {},
          tagline: input.tagline ?? '',
          endings: [],
          openings: [],
          terminology: [],
          samples: [],
          platformGuidance: '',
          source: 'brand',
          socialSetName: '',
        }
      )
    }),
  get: organizationProcedure('brand:manage').query(async ({ ctx }) => {
    const brandProfile = await getBrandProfile(ctx.access)
    return { brandProfile }
  }),
  upsert: organizationProcedure('brand:manage')
    .input(brandProfileUpsertSchema)
    .mutation(async ({ ctx, input }) => {
      const brandProfile = await upsertBrandProfile(ctx.access, input)
      return { brandProfile }
    }),
})

export const sourceAppRouter = router({
  create: tenantProcedure({ apiKeyScope: 'source:write', permission: 'brand:manage' })
    .input(sourceAppCreateSchema)
    .mutation(async ({ ctx, input }) => {
      const sourceApp = await createSourceApp(ctx.tenant, input)
      return { sourceApp, webhook: getSourceWebhookSetup(sourceApp) }
    }),
})
