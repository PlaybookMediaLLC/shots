import { tool } from 'ai'
import { z } from 'zod'
import { designCatalogSections } from '@/lib/design/catalog'
import { describeDesignCatalog } from '@/lib/design/catalog-sections'
import { variantCountSchema } from '@/lib/ai/variants'
import { copyLengthSchema, copyToneSchema } from '@/lib/api/contracts/store-screenshots'
import { designEditSchema } from '@/lib/design/document'
import { backgroundRequestSchema } from '@/lib/ai/images/background-request'
import {
  boardEditSchema,
  codeSceneEditSchema,
  draftProposalSchema,
  storySetEditSchema,
  tweetEditSchema,
} from '@/lib/assistant/surface-commands'
import { storeModelCommandSchema } from '@/lib/store-screenshots/commands/schema'
import type { ToolCapability } from './executor'

/**
 * Tools for the in-editor and studio copilots.
 *
 * Client-executed tools omit `execute`: the model's call returns to the
 * browser surface adapter, which runs it against the live editor store (using
 * the exact same actions and single-step undo as the editor's controls) and
 * sends back the structured result and a fresh canvas snapshot.
 */

export const editorClientToolNames = [
  'inspectCanvas',
  'applyChanges',
  'undoLastChange',
  'showVariants',
  'reviewDesign',
  'showCaptions',
  'generateAiBackground',
  'applyBrandKit',
  'scanRedactions',
  'captureIntoCanvas',
  'insertWorkspaceAsset',
  'inspectStoreSet',
  'dispatchStoreCommands',
  'generateStoreCopy',
  'translateStoreLocales',
  'preparePost',
  'applySavedPreset',
  'inspectTweet',
  'editTweet',
  'inspectBoard',
  'editBoard',
  'inspectStorySet',
  'editStorySet',
  'inspectCodeScene',
  'editCodeScene',
  'inspectDraft',
  'proposeDraftText',
] as const
export type EditorClientToolName = (typeof editorClientToolNames)[number]

/**
 * RFC 027 capability records, for documentation and permission reference:
 * the browser runs these tools against the open surface only when the caller
 * holds `artifact:edit` (enforced server-side before exposing them).
 */
export const editorCopilotCapabilities = {
  applyBrandKit: { effect: 'draft', maxCallsPerRun: 2, permission: 'artifact:edit' },
  applyChanges: { effect: 'draft', maxCallsPerRun: 6, permission: 'artifact:edit' },
  captureIntoCanvas: { effect: 'draft', maxCallsPerRun: 2, permission: 'artifact:edit' },
  editBoard: { effect: 'draft', maxCallsPerRun: 4, permission: 'artifact:edit' },
  editCodeScene: { effect: 'draft', maxCallsPerRun: 4, permission: 'artifact:edit' },
  editStorySet: { effect: 'draft', maxCallsPerRun: 4, permission: 'artifact:edit' },
  inspectBoard: { effect: 'read', maxCallsPerRun: 4, permission: 'artifact:read' },
  inspectCodeScene: { effect: 'read', maxCallsPerRun: 4, permission: 'artifact:read' },
  inspectDraft: { effect: 'read', maxCallsPerRun: 4, permission: 'artifact:read' },
  inspectStorySet: { effect: 'read', maxCallsPerRun: 4, permission: 'artifact:read' },
  applySavedPreset: { effect: 'draft', maxCallsPerRun: 3, permission: 'artifact:edit' },
  editTweet: { effect: 'draft', maxCallsPerRun: 4, permission: 'artifact:edit' },
  inspectTweet: { effect: 'read', maxCallsPerRun: 4, permission: 'artifact:read' },
  preparePost: { effect: 'read', maxCallsPerRun: 1, permission: 'artifact:edit' },
  proposeDraftText: { effect: 'read', maxCallsPerRun: 4, permission: 'artifact:edit' },
  dispatchStoreCommands: { effect: 'draft', maxCallsPerRun: 6, permission: 'artifact:edit' },
  generateAiBackground: { effect: 'draft', maxCallsPerRun: 2, permission: 'artifact:edit' },
  generateStoreCopy: { effect: 'read', maxCallsPerRun: 2, permission: 'artifact:edit' },
  insertWorkspaceAsset: { effect: 'draft', maxCallsPerRun: 3, permission: 'artifact:edit' },
  inspectCanvas: { effect: 'read', maxCallsPerRun: 4, permission: 'artifact:read' },
  inspectStoreSet: { effect: 'read', maxCallsPerRun: 4, permission: 'artifact:read' },
  listDesignOptions: { effect: 'read', maxCallsPerRun: 4, permission: 'workspace:read' },
  reviewDesign: { effect: 'read', maxCallsPerRun: 1, permission: 'artifact:edit' },
  scanRedactions: { effect: 'read', maxCallsPerRun: 1, permission: 'artifact:edit' },
  showCaptions: { effect: 'read', maxCallsPerRun: 1, permission: 'artifact:edit' },
  showVariants: { effect: 'read', maxCallsPerRun: 1, permission: 'artifact:edit' },
  translateStoreLocales: { effect: 'draft', maxCallsPerRun: 2, permission: 'artifact:edit' },
  undoLastChange: { effect: 'draft', maxCallsPerRun: 4, permission: 'artifact:edit' },
} as const satisfies Record<string, ToolCapability>

const brandCategorySchema = z.enum(['colors', 'typography', 'background', 'frame', 'logo'])

/** The tools of one turn: only those the mounted surface says it can run. */
export function createEditorCopilotTools(allowedClientTools: readonly string[]) {
  const allTools = {
    editBoard: tool({
      description:
        'Move, rename, duplicate, restack, or resize artboards on the canvas board in one change.',
      inputSchema: boardEditSchema,
    }),
    editCodeScene: tool({
      description:
        'Edit the open code project: code text and line marks, slide captions, timing, order, and layout. Duplicate a slide before changing it to animate a step.',
      inputSchema: codeSceneEditSchema,
    }),
    editStorySet: tool({
      description:
        'Edit the open Story Set: story and format wording, focus, layout, and story order.',
      inputSchema: storySetEditSchema,
    }),
    inspectBoard: tool({
      description: 'Read the canvas board: artboard ids, names, positions, and sizes.',
      inputSchema: z.object({}),
    }),
    inspectCodeScene: tool({
      description: 'Read the open code project: slides, panes, code, and captions.',
      inputSchema: z.object({}),
    }),
    inspectDraft: tool({
      description:
        'Read the open draft: platform, the posts as the platform reads them, and any selected text.',
      inputSchema: z.object({}),
    }),
    inspectStorySet: tool({
      description: 'Read the open Story Set: stories, formats, and their wording.',
      inputSchema: z.object({}),
    }),
    proposeDraftText: tool({
      description:
        'Offer new text for the open draft as a card. The draft changes only if the person accepts it.',
      inputSchema: draftProposalSchema,
    }),
    applyBrandKit: tool({
      description:
        'Apply a workspace brand kit by id or name to the live design in one undo step, preserving user overrides unless resetOverrides is true.',
      inputSchema: z.object({
        categories: z
          .array(brandCategorySchema)
          .min(1)
          .max(5)
          .optional()
          .describe('Brand kit categories to apply (defaults to all available in the kit).'),
        kitId: z.string().trim().min(1).max(64).optional().describe('Brand kit id from listBrandKits.'),
        kitName: z.string().trim().min(1).max(120).optional().describe('Brand kit name if id is unknown.'),
        resetOverrides: z.boolean().default(false),
      }),
    }),
    applyChanges: tool({
      description:
        'Change the live design. Send only the sections you are changing; lists replace the ' +
        'whole list. Returns a snapshot of the canvas after the change. One call is one undo step.',
      inputSchema: designEditSchema,
    }),
    captureIntoCanvas: tool({
      description:
        'Capture a public website URL or a registered product surface screenshot and load it onto the canvas as the main screenshot.',
      inputSchema: z.object({
        colorScheme: z.enum(['light', 'dark']).default('dark'),
        deviceType: z.enum(['desktop', 'mobile']).default('desktop'),
        url: z.string().url().max(2_000).describe('Public https:// URL to capture into the canvas.'),
      }),
    }),
    dispatchStoreCommands: tool({
      description:
        'Apply one or more Store Studio commands to the active App Store / Play Store screenshot project in a single undo step.',
      inputSchema: z.object({
        commands: z.array(storeModelCommandSchema).min(1).max(20),
        summary: z.string().trim().min(1).max(160),
      }),
    }),
    generateAiBackground: tool({
      description:
        'Generate a custom AI background image from a visual description and apply it to the canvas background in one undo step.',
      inputSchema: backgroundRequestSchema,
    }),
    generateStoreCopy: tool({
      description:
        'Generate App Store / Play Store headline and subheadline suggestions grounded in the project brief and save them to the project.',
      inputSchema: z.object({
        brief: z.string().trim().max(4000).optional(),
        count: z.number().int().min(1).max(6).default(3),
        length: copyLengthSchema.default('short'),
        locale: z.string().trim().max(16).optional(),
        scope: z.enum(['active', 'all']).default('active'),
        tone: copyToneSchema.default('confident'),
      }),
    }),
    insertWorkspaceAsset: tool({
      description:
        'Place a workspace library image asset (found via searchWorkspaceAssets) onto the canvas as an overlay or main screenshot.',
      inputSchema: z.object({
        assetId: z.string().trim().min(1).max(80),
        placement: z.enum(['overlay', 'main']).default('overlay'),
        x: z.number().min(0).max(1).optional(),
        y: z.number().min(0).max(1).optional(),
      }),
    }),
    inspectCanvas: tool({
      description:
        'See the current design document, the selected element, and a snapshot of the canvas.',
      inputSchema: z.object({}),
    }),
    inspectStoreSet: tool({
      description:
        'Inspect the active Store Screenshots project: slides, active slide index, headlines, locales, backgrounds, and compliance issues.',
      inputSchema: z.object({}),
    }),
    listDesignOptions: tool({
      description:
        'Look up option ids: templates, aspectRatios, backgrounds, fonts, mockups, frames, ' +
        'overlays, animation.',
      execute: async ({ section }) => ({ options: describeDesignCatalog(section), section }),
      inputSchema: z.object({ section: z.enum(designCatalogSections) }),
    }),
    applySavedPreset: tool({
      description:
        'Apply one of the workspace’s saved design presets to the screenshot in one undo step. Without a name, lists them.',
      inputSchema: z.object({ name: z.string().trim().max(120).optional() }),
    }),
    editTweet: tool({
      description: 'Style the open tweet image: card theme, background on or off, and padding.',
      inputSchema: tweetEditSchema,
    }),
    inspectTweet: tool({
      description: 'Read the open tweet image: the post and its styling.',
      inputSchema: z.object({}),
    }),
    preparePost: tool({
      description:
        'Show a button that starts a post from the open design. Use it when the person wants to post or share it.',
      inputSchema: z.object({}),
    }),
    reviewDesign: tool({
      description:
        'Run a visual design critique of the current canvas and show up to three one-click improvement cards in the thread.',
      inputSchema: z.object({}),
    }),
    scanRedactions: tool({
      description:
        'Open the on-device PII scanner (emails, API keys, cards, names, faces) on the current screenshot so the user can review and blur detections.',
      inputSchema: z.object({}),
    }),
    showCaptions: tool({
      description:
        'Show the interactive Captions & Alt Text panel inline in the conversation for the current design.',
      inputSchema: z.object({
        notes: z.string().trim().max(300).optional().describe('Optional angle or notes for the captions.'),
      }),
    }),
    showVariants: tool({
      description:
        'Show the user several complete versions of the design side by side to pick from. Use it ' +
        'when they ask for versions, variants, options, or alternatives. It does not change the design.',
      inputSchema: z.object({
        count: variantCountSchema.describe('How many versions, 2 to 6.'),
        instruction: z
          .string()
          .max(300)
          .optional()
          .describe('What the versions should explore, in the user’s words.'),
      }),
    }),
    translateStoreLocales: tool({
      description:
        'Translate the Store Screenshots project into one or more target locale codes (e.g. ["es", "fr", "ja"]).',
      inputSchema: z.object({
        locales: z.array(z.string().trim().min(2).max(16)).min(1).max(10),
      }),
    }),
    undoLastChange: tool({
      description: 'Undo the most recent change, yours or the user’s. Returns a snapshot.',
      inputSchema: z.object({}),
    }),
  }

  const allowed = new Set<string>([
        ...allowedClientTools,
        ...(allowedClientTools.includes('applyChanges') || allowedClientTools.includes('inspectCanvas')
          ? ['listDesignOptions']
          : []),
  ])

  return Object.fromEntries(
    Object.entries(allTools).filter(([name]) => allowed.has(name))
  ) as Partial<typeof allTools>
}
