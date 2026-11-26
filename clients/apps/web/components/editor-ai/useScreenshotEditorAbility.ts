'use client'

import type { TRPCClient } from '@trpc/client'
import type { ToolResultPart } from 'ai'
import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import {
  useAssistantAbility,
  useAssistantPage,
} from '@/components/assistant/AssistantProvider'
import {
  type ClientToolExecutor,
  runUnifiedAssistant,
} from '@/components/assistant/run-unified-assistant'
import { useEditorActive } from '@/components/platform-shell/EditorActiveContext'
import { withoutImageSources } from '@/lib/design/without-image-sources'
import { backgroundAspectSchema } from '@/lib/ai/images/background-request'
import { variantCountSchema } from '@/lib/ai/variants'
import type { AssistantEntry, AssistantQuickAction } from '@/lib/assistant/ability'
import { applyPreset, loadPresets } from '@/lib/presets/library'
import { useProjectSession } from '@/lib/projects/session'
import { availableBrandCategories, type BrandCategory } from '@/lib/brand/apply'
import { applyBrandKitToEditor, loadBrandKits, useBrandKits } from '@/lib/brand/library'
import { applyDesignChanges } from '@/lib/design/apply'
import { designEditSchema } from '@/lib/design/document'
import { describeSelection, exportDesignDocument } from '@/lib/design/export'
import { fetchAssetUrl } from '@/lib/design/open-design'
import { captureCanvasSnapshot } from '@/lib/design/snapshot'
import { rememberUploadedSources } from '@/lib/design/upload-sources'
import { useImageStore } from '@/lib/store'
import { useDeviceUIStore } from '@/lib/store/device-ui'
import type { AppRouter } from '@/lib/trpc/router'
import { useTRPCClient } from '@/lib/trpc/react'
import { buildExportFileName } from '@/lib/workspace/save-export'

type Client = TRPCClient<AppRouter>

const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

/** All client-executed tools exposed by the Screenshot Editor surface. */
export const SCREENSHOT_EDITOR_CLIENT_TOOLS = [
  'inspectCanvas',
  'applyChanges',
  'undoLastChange',
  'reviewDesign',
  'showVariants',
  'showCaptions',
  'generateAiBackground',
  'applyBrandKit',
  'scanRedactions',
  'captureIntoCanvas',
  'insertWorkspaceAsset',
  'preparePost',
  'applySavedPreset',
] as const

const EDITOR_QUICK_ACTIONS: readonly AssistantQuickAction[] = [
  {
    description: 'Critique contrast, framing, hierarchy, and polish with 1-click fixes',
    id: 'review',
    label: 'Review',
    prompt: 'Review this design and suggest the highest-impact improvements.',
  },
  {
    description: 'Generate complete visual alternatives to compare side by side',
    id: 'variants',
    label: 'Variants',
    prompt: 'Show me 4 distinct visual versions of this design.',
  },
  {
    description: 'Write alt text and platform-specific social captions',
    id: 'captions',
    label: 'Captions',
    prompt: 'Write alt text and social captions for this design.',
  },
  {
    description: 'Generate a custom abstract AI background matched to the canvas',
    id: 'ai-bg',
    label: 'AI BG',
    prompt: 'Generate an atmospheric AI background that complements this screenshot.',
  },
  {
    description: 'Scan locally for emails, API keys, names, cards, and faces',
    id: 'redact',
    label: 'Redact PII',
    prompt: 'Scan this screenshot for sensitive personal details to redact.',
  },
]

const EDITOR_SUGGESTIONS = [
  'Make it pop on a dark gradient with a punchy headline',
  'Put it in a laptop mockup with a spotlight on the hero',
  'Apply my workspace brand kit and polish the framing',
  'Make a 9:16 vertical version for stories',
]

const ASPECTS = [
  ['1:1', 1],
  ['4:5', 0.8],
  ['3:4', 0.75],
  ['2:3', 2 / 3],
  ['9:16', 9 / 16],
  ['5:4', 1.25],
  ['4:3', 4 / 3],
  ['3:2', 1.5],
  ['16:9', 16 / 9],
  ['21:9', 21 / 9],
] as const

function nearestAspect(width: number, height: number) {
  const ratio = width / Math.max(1, height)
  return ASPECTS.reduce((best, entry) =>
    Math.abs(Math.log(entry[1] / ratio)) < Math.abs(Math.log(best[1] / ratio)) ? entry : best
  )[0]
}

const variantsInputSchema = z.object({
  count: variantCountSchema.default(4),
  instruction: z.string().max(300).default(''),
})
const captionsInputSchema = z.object({
  instruction: z.string().max(300).optional(),
  notes: z.string().max(300).optional(),
})
const aiBackgroundInputSchema = z.object({
  aspect: backgroundAspectSchema.optional(),
  palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).max(8).optional(),
  prompt: z.string().trim().min(3).max(600),
})
const applyBrandKitInputSchema = z.object({
  categories: z.array(z.enum(['colors', 'typography', 'background', 'frame', 'logo'])).optional(),
  kitId: z.string().max(120).optional(),
  kitName: z.string().max(120).optional(),
  resetOverrides: z.boolean().optional(),
})
const captureIntoCanvasInputSchema = z.object({
  colorScheme: z.enum(['light', 'dark']).default('dark'),
  deviceType: z.enum(['desktop', 'mobile']).default('desktop'),
  url: z.string().url().max(500),
})
const presetInputSchema = z.object({ name: z.string().trim().max(120).optional() })
const insertAssetInputSchema = z.object({
  assetId: z.string().min(1).max(120),
  placement: z.enum(['overlay', 'main']).default('overlay'),
})

async function snapshotParts(text: string): Promise<ToolResultPart['output']> {
  await nextFrame()
  const snapshot = await captureCanvasSnapshot()
  return {
    type: 'content',
    value: [
      { text, type: 'text' },
      ...(snapshot
        ? [
            {
              data: { data: snapshot, type: 'data' as const },
              mediaType: 'image/jpeg',
              type: 'file' as const,
            },
          ]
        : []),
    ],
  }
}

/** A thread entry whose Undo works only while this change is still the newest edit. */
function editorChange(text: string, canUndo: boolean): AssistantEntry {
  if (!canUndo) return { kind: 'change', text }
  const mark = useImageStore.temporal.getState().pastStates.at(-1)
  return {
    kind: 'change',
    text,
    undo: () => {
      const history = useImageStore.temporal.getState()
      if (history.pastStates.at(-1) !== mark) return false
      history.undo()
      return true
    },
  }
}

/**
 * Shared client tool executor for the Screenshot Editor (also reused by Canvas
 * when an artboard is open in the editor).
 */
export function createScreenshotEditorToolExecutor(
  trpcClient: Client,
  { canUndo = true }: { canUndo?: boolean } = {}
): ClientToolExecutor {
  return async (call, { push, signal }) => {
    switch (call.toolName) {
      case 'inspectCanvas':
        return snapshotParts(
          JSON.stringify({
            design: exportDesignDocument(),
            selection: describeSelection()?.label ?? null,
          })
        )

      case 'applyChanges': {
        const parsed = designEditSchema.safeParse(call.input)
        if (!parsed.success) {
          return {
            type: 'error-text',
            value: `Invalid changes: ${parsed.error.message.slice(0, 600)}`,
          }
        }
        try {
          await applyDesignChanges(withoutImageSources(parsed.data.changes), (ref) => ref)
        } catch (error) {
          return {
            type: 'error-text',
            value: `The change could not be applied: ${error instanceof Error ? error.message : 'unknown'}`,
          }
        }
        push(editorChange(parsed.data.summary, canUndo))
        return snapshotParts(JSON.stringify({ applied: true, summary: parsed.data.summary }))
      }

      case 'undoLastChange': {
        if (!canUndo) {
          return {
            type: 'error-text',
            value: 'Undo is not available to the copilot here. Tell the person to press ⌘Z.',
          }
        }
        useImageStore.temporal.getState().undo()
        push({ kind: 'change', text: 'Undid the last change' })
        return snapshotParts(JSON.stringify({ undone: true }))
      }

      case 'reviewDesign': {
        const document = exportDesignDocument()
        const snapshot = await captureCanvasSnapshot(480)
        try {
          const { suggestions } = await trpcClient.editorAi.critique.mutate({
            document,
            snapshot,
          })
          if (suggestions.length > 0) {
            push({ items: suggestions, kind: 'suggestions' })
          }
          return {
            type: 'text',
            value: JSON.stringify({
              count: suggestions.length,
              suggestions: suggestions.map((item) => ({
                reason: item.reason,
                title: item.title,
              })),
            }),
          }
        } catch (error) {
          return {
            type: 'error-text',
            value: `Could not review design: ${error instanceof Error ? error.message : 'unknown'}`,
          }
        }
      }

      case 'showVariants': {
        const parsed = variantsInputSchema.safeParse(call.input ?? {})
        if (!parsed.success) {
          return { type: 'error-text', value: 'Invalid variants request.' }
        }
        push({
          count: parsed.data.count,
          instruction: parsed.data.instruction,
          kind: 'variants',
        })
        return {
          type: 'text',
          value: `Opened the visual variants card for ${parsed.data.count} versions. The design stays unchanged until the person picks one.`,
        }
      }

      case 'showCaptions': {
        const parsed = captionsInputSchema.safeParse(call.input ?? {})
        push({
          instruction: parsed.success ? (parsed.data.notes ?? parsed.data.instruction) : undefined,
          kind: 'captions',
        })
        return {
          type: 'text',
          value: 'Opened the alt text and social captions card inline in the thread.',
        }
      }

      case 'generateAiBackground': {
        const parsed = aiBackgroundInputSchema.safeParse(call.input)
        if (!parsed.success) {
          return { type: 'error-text', value: `Invalid background request: ${parsed.error.message}` }
        }
        const canvas = useImageStore.getState().canvasDimensions
        const aspect =
          parsed.data.aspect ?? (canvas ? nearestAspect(canvas.canvasW, canvas.canvasH) : '16:9')
        try {
          const { assetId } = await trpcClient.editorAi.generateBackground.mutate({
            aspect,
            palette: parsed.data.palette ?? [],
            prompt: parsed.data.prompt,
          })
          const url = await fetchAssetUrl(trpcClient, assetId)
          signal?.throwIfAborted()
          await applyDesignChanges(
            {
              background: {
                blur: 0,
                noise: 0,
                opacity: 1,
                type: 'image',
                value: `asset:${assetId}`,
              },
            },
            (ref) => (ref === `asset:${assetId}` ? url : ref)
          )
          rememberUploadedSources({ [`asset:${assetId}`]: url })
          push(editorChange('Generated and applied AI background', canUndo))
          return snapshotParts(JSON.stringify({ applied: true, assetId }))
        } catch (error) {
          signal?.throwIfAborted()
          return {
            type: 'error-text',
            value: `Could not generate background: ${error instanceof Error ? error.message : 'unknown'}`,
          }
        }
      }

      case 'applyBrandKit': {
        const parsed = applyBrandKitInputSchema.safeParse(call.input ?? {})
        if (!parsed.success) {
          return { type: 'error-text', value: 'Invalid brand kit request.' }
        }
        try {
          let kits = useBrandKits.getState().kits
          if (kits.length === 0) kits = await loadBrandKits(trpcClient)
          if (kits.length === 0) {
            return {
              type: 'error-text',
              value: 'No visual brand kits exist in this workspace yet.',
            }
          }
          const byId = parsed.data.kitId
            ? kits.find((kit) => kit.id === parsed.data.kitId)
            : undefined
          const byName = parsed.data.kitName
            ? kits.find(
                (kit) => kit.name.toLowerCase() === parsed.data.kitName!.trim().toLowerCase()
              )
            : undefined
          const asked = parsed.data.kitId ?? parsed.data.kitName
          const kit = asked ? (byId ?? byName) : kits[0]
          if (!kit) {
            return {
              type: 'error-text',
              value: `No brand kit matches “${asked}”. Available: ${kits.map((item) => item.name).join(', ')}.`,
            }
          }
          const categories: readonly BrandCategory[] =
            parsed.data.categories && parsed.data.categories.length > 0
              ? parsed.data.categories
              : availableBrandCategories(kit)
          signal?.throwIfAborted()
          const keptOverrides = await applyBrandKitToEditor(trpcClient, kit, categories, {
            resetOverrides: parsed.data.resetOverrides ?? false,
          })
          push(editorChange(`Applied brand kit “${kit.name}”`, canUndo))
          return snapshotParts(
            JSON.stringify({
              applied: true,
              categories,
              keptOverrides,
              kitName: kit.name,
            })
          )
        } catch (error) {
          signal?.throwIfAborted()
          return {
            type: 'error-text',
            value: `Could not apply brand kit: ${error instanceof Error ? error.message : 'unknown'}`,
          }
        }
      }

      case 'applySavedPreset': {
        const parsed = presetInputSchema.safeParse(call.input ?? {})
        if (!parsed.success) return { type: 'error-text', value: 'Invalid preset request.' }
        const presets = await loadPresets(trpcClient)
        const names = presets.map((preset) => preset.name)
        if (!parsed.data.name) return { type: 'text', value: JSON.stringify({ presets: names }) }
        const asked = parsed.data.name.toLowerCase()
        const preset = presets.find((item) => item.name.toLowerCase() === asked)
        if (!preset) {
          return {
            type: 'error-text',
            value: `No preset is named “${parsed.data.name}”. Saved: ${names.join(', ') || 'none'}.`,
          }
        }
        signal?.throwIfAborted()
        await applyPreset(trpcClient, preset)
        push(editorChange(`Applied preset “${preset.name}”`, canUndo))
        return snapshotParts(JSON.stringify({ applied: preset.name }))
      }

      case 'preparePost': {
        push({ kind: 'handoff' })
        return {
          type: 'text',
          value: 'Showed a button to post this design. Nothing is posted until the person does it.',
        }
      }

      case 'scanRedactions': {
        push({ autoScan: true, kind: 'redactions' })
        return {
          type: 'text',
          value:
            'Opened the on-device PII redaction scanner card. The user can inspect detected regions and apply pixel-destructive redactions locally.',
        }
      }

      case 'captureIntoCanvas': {
        const parsed = captureIntoCanvasInputSchema.safeParse(call.input)
        if (!parsed.success) {
          return { type: 'error-text', value: `Invalid URL: ${parsed.error.message}` }
        }
        try {
          const response = await fetch('/api/screenshot', {
            body: JSON.stringify({
              colorScheme: parsed.data.colorScheme,
              deviceType: parsed.data.deviceType,
              url: parsed.data.url,
            }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
            signal,
          })
          const body: unknown = await response.json().catch(() => null)
          if (!response.ok || !body || typeof body !== 'object' || !('screenshot' in body)) {
            const message =
              body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
                ? body.error
                : 'Screenshot capture failed.'
            return { type: 'error-text', value: message }
          }
          // The route answers with base64 PNG bytes, not a URL. `atob` throws on anything else.
          const encoded = String(body.screenshot).trim().split(',').at(-1) ?? ''
          const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
          if (bytes.length === 0) {
            return { type: 'error-text', value: 'Screenshot capture returned no image.' }
          }
          const file = new File([bytes], buildExportFileName('image/png'), { type: 'image/png' })
          signal?.throwIfAborted()
          useImageStore.getState().setImage(file)
          push(editorChange(`Captured ${parsed.data.url}`, canUndo))
          return snapshotParts(JSON.stringify({ captured: true, url: parsed.data.url }))
        } catch (error) {
          signal?.throwIfAborted()
          return {
            type: 'error-text',
            value: `Could not capture URL: ${error instanceof Error ? error.message : 'unknown'}`,
          }
        }
      }

      case 'insertWorkspaceAsset': {
        const parsed = insertAssetInputSchema.safeParse(call.input)
        if (!parsed.success) {
          return { type: 'error-text', value: 'Invalid asset id.' }
        }
        try {
          const url = await fetchAssetUrl(trpcClient, parsed.data.assetId)
          if (parsed.data.placement === 'main') {
            const response = await fetch(url, { signal })
            const blob = await response.blob()
            const file = new File([blob], buildExportFileName(blob.type || 'image/png'), {
              type: blob.type || 'image/png',
            })
            signal?.throwIfAborted()
            useImageStore.getState().setImage(file)
          } else {
            signal?.throwIfAborted()
            const canvas = useImageStore.getState().canvasDimensions
            const x = canvas ? Math.round(canvas.canvasW * 0.5) : 400
            const y = canvas ? Math.round(canvas.canvasH * 0.5) : 300
            useImageStore.getState().addImageOverlay({
              flipX: false,
              flipY: false,
              isCustom: true,
              isVisible: true,
              layer: 'front',
              opacity: 1,
              position: { x, y },
              rotation: 0,
              size: 160,
              src: url,
            })
          }
          rememberUploadedSources({ [`asset:${parsed.data.assetId}`]: url })
          push(
            editorChange(parsed.data.placement === 'main'
                ? 'Loaded workspace asset as main screenshot'
                : 'Added workspace asset as overlay', canUndo)
          )
          return snapshotParts(
            JSON.stringify({ inserted: true, placement: parsed.data.placement })
          )
        } catch (error) {
          return {
            type: 'error-text',
            value: `Could not insert asset: ${error instanceof Error ? error.message : 'unknown'}`,
          }
        }
      }

      default:
        return { type: 'error-text', value: `Unknown tool ${call.toolName}.` }
    }
  }
}

/**
 * Registers the Screenshot Editor with the unified Shots Assistant:
 * docked side inspector by default, live selection scope, quick actions,
 * workspace + editor tool composition, and live page context facts.
 */
export function useScreenshotEditorAbility() {
  const active = useEditorActive()
  const trpcClient = useTRPCClient()

  // Subscribe only to compact selection + page summary slices so edits don't churn the provider.
  const hasImage = useImageStore(
    (state) => Boolean(state.uploadedImageUrl) || state.mockups.length > 0
  )
  const aspectRatio = useImageStore((state) => state.selectedAspectRatio)
  const editorMode = useImageStore((state) => state.editorMode)
  const brandName = useImageStore((state) => state.brand?.name ?? null)
  const textCount = useImageStore((state) => state.textOverlays.length)
  const elementCount = useImageStore((state) => state.elements.length)
  const mockupCount = useImageStore((state) => state.mockups.length)
  const selectedTextId = useImageStore((state) => state.selectedTextId)
  const selectedOverlayId = useImageStore((state) => state.selectedOverlayId)
  const selectedAnnotationId = useImageStore((state) => state.selectedAnnotationId)
  const selectedElementId = useImageStore((state) => state.selectedElementId)
  const selectedBlurId = useImageStore((state) => state.selectedBlurId)
  const selectedDeviceId = useDeviceUIStore((state) => state.selectedDeviceId)

  // Recompute human-readable selection label whenever any selection pointer changes.
  const selectionLabel = useMemo(() => {
    void selectedTextId
    void selectedOverlayId
    void selectedAnnotationId
    void selectedElementId
    void selectedBlurId
    void selectedDeviceId
    return describeSelection()?.label ?? null
  }, [
    selectedAnnotationId,
    selectedBlurId,
    selectedDeviceId,
    selectedElementId,
    selectedOverlayId,
    selectedTextId,
  ])

  // Warm brand kits in the background when the editor mounts so `applyBrandKit` is instant.
  useEffect(() => {
    if (!active) return
    if (useBrandKits.getState().kits.length === 0) {
      void loadBrandKits(trpcClient).catch(() => undefined)
    }
  }, [active, trpcClient])

  const executeClientTool = useMemo(
    () => createScreenshotEditorToolExecutor(trpcClient, { canUndo: true }),
    [trpcClient]
  )

  // A different project starts a new conversation; the first save of this one does not.
  const projectId = useProjectSession((session) => session.projectId)
  const [opened, setOpened] = useState({ count: 0, projectId })
  if (opened.projectId !== projectId) {
    setOpened({ count: opened.projectId ? opened.count + 1 : opened.count, projectId })
  }

  useAssistantAbility(
    {
      id: `screenshot-editor:${opened.count}`,
      label: 'Screenshot editor',
      placeholder: selectionLabel
        ? `Ask to change ${selectionLabel}, or anything else…`
        : 'Ask to edit this design, apply brand kit, review, or search workspace…',
      preferredMode: 'dock',
      priority: 10,
      quickActions: [...EDITOR_QUICK_ACTIONS],
      run: (run) =>
        runUnifiedAssistant({
          ...run,
          clientTools: SCREENSHOT_EDITOR_CLIENT_TOOLS,
          executeClientTool,
        }),
      selection: selectionLabel,
      suggestions: EDITOR_SUGGESTIONS,
      surface: 'screenshot-editor',
    },
    active
  )

  const facts = useMemo(() => {
    const items = [
      `Screenshot editor (${editorMode} mode, aspect ratio ${aspectRatio}).`,
      hasImage
        ? 'A screenshot or device mockup is loaded on the canvas.'
        : 'No screenshot is uploaded yet.',
      `Layers: ${textCount} text, ${elementCount} composition elements, ${mockupCount} device mockups.`,
    ]
    if (brandName) items.push(`Bound brand kit: ${brandName}.`)
    return items
  }, [aspectRatio, brandName, editorMode, elementCount, hasImage, mockupCount, textCount])

  useAssistantPage({ facts }, active)
}
