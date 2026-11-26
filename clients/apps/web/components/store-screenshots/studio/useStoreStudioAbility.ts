'use client'

import { useMemo } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
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
import { copyLengthSchema, copyToneSchema } from '@/lib/api/contracts/store-screenshots'
import type { AssistantEntry, AssistantQuickAction } from '@/lib/assistant/ability'
import { type Command, commandSchema } from '@/lib/store-screenshots/commands/schema'
import type { TextLayer } from '@/lib/store-screenshots/document/schema'
import { decodeSpans, encodeSpans, pendingTranslations } from '@/lib/store-screenshots/localization'
import { requestJson } from './dialogs/request'
import type { EditorState } from './editor-store'

const STORE_CLIENT_TOOLS = [
  'inspectStoreSet',
  'dispatchStoreCommands',
  'generateStoreCopy',
  'translateStoreLocales',
] as const

const STORE_QUICK_ACTIONS: readonly AssistantQuickAction[] = [
  {
    description: 'Inspect all slides, locales, and copy for hierarchy and polish',
    id: 'audit-set',
    label: 'Audit set',
    prompt: 'Inspect my App Store screenshot set and suggest improvements to headlines and flow.',
  },
  {
    description: 'Generate grounded App Store headlines across slides',
    id: 'store-copy',
    label: 'Write headlines',
    prompt: 'Generate punchy, concise App Store headlines for all slides in this set.',
  },
  {
    description: 'Translate slide text layers into configured target locales',
    id: 'translate',
    label: 'Translate locales',
    prompt: 'Translate all pending slide text into my project locales.',
  },
]

const STORE_SUGGESTIONS = [
  'Inspect my slides and tighten the headlines for App Store scannability',
  'Write 3 punchy headline options for the active slide',
  'Translate my slides into all configured locales',
  'Check my workspace brand profile and match the slide theme',
]

const dispatchInputSchema = z.object({
  commands: z.array(z.unknown()).min(1).max(20),
  summary: z.string().trim().min(1).max(160),
})

const copyInputSchema = z.object({
  brief: z.string().trim().max(4000).optional(),
  count: z.number().int().min(1).max(6).default(3),
  length: copyLengthSchema.default('short'),
  locale: z.string().trim().max(16).optional(),
  scope: z.enum(['active', 'all']).default('active'),
  tone: copyToneSchema.default('confident'),
})

const translateInputSchema = z.object({
  locales: z.array(z.string().trim().min(2).max(16)).max(30).optional(),
})

/** A thread entry whose Undo works only while this change is still the newest edit. */
function storeChange(
  store: StoreApi<EditorState>,
  text: string,
  /** How many history steps the change took. */
  steps = 1
): AssistantEntry {
  const after = store.getState().document
  return {
    kind: 'change',
    text,
    undo: () => {
      if (store.getState().document !== after) return false
      for (let step = 0; step < steps; step += 1) store.getState().undo()
      return true
    },
  }
}

function summarizeStoreSet(state: EditorState) {
  const { document, activeSlideId, locale, targetId } = state
  return {
    activeSlideId,
    locale,
    locales: [document.localization.sourceLocale, ...document.localization.locales],
    name: document.name,
    productBrief: document.productBrief.slice(0, 600),
    slides: document.slides.map((slide, index) => ({
      id: slide.id,
      index: index + 1,
      layout: slide.layout,
      name: slide.name,
      background: slide.background,
      layers: slide.layers.map((layer) => ({ id: layer.id, type: layer.type })),
      texts: slide.layers
        .filter((layer): layer is TextLayer => layer.type === 'text')
        .map((layer) => ({
          id: layer.id,
          role: layer.role,
          text: layer.content.map((span) => span.text).join(''),
        })),
    })),
    sourceLocale: document.localization.sourceLocale,
    targetId,
    theme: {
      palette: document.theme.palette,
    },
  }
}

/**
 * Registers the App Store / Play Store Screenshots studio with the unified
 * Shots Assistant, exposing set inspection, validated command dispatch,
 * grounded headline generation, and multi-locale translation.
 */
export function useStoreStudioAbility(
  store: StoreApi<EditorState>,
  issueCount: { requirements: number; recommendations: number }
) {
  const active = useEditorActive()
  const projectId = useStore(store, (state) => state.document.id)
  const projectName = useStore(store, (state) => state.document.name)
  const slideCount = useStore(store, (state) => state.document.slides.length)
  const activeSlideId = useStore(store, (state) => state.activeSlideId)
  const locale = useStore(store, (state) => state.locale)
  const localeCount = useStore(store, (state) => 1 + state.document.localization.locales.length)

  const activeSlideName = useStore(
    store,
    (state) => state.document.slides.find((slide) => slide.id === state.activeSlideId)?.name ?? null
  )

  const executeClientTool = useMemo<ClientToolExecutor>(
    () => async (call, { push, signal }) => {
      switch (call.toolName) {
        case 'inspectStoreSet': {
          return {
            type: 'text',
            value: JSON.stringify(summarizeStoreSet(store.getState())),
          }
        }

        case 'dispatchStoreCommands': {
          const parsed = dispatchInputSchema.safeParse(call.input)
          if (!parsed.success) {
            return { type: 'error-text', value: `Invalid commands payload: ${parsed.error.message}` }
          }
          const validated: Command[] = []
          for (const raw of parsed.data.commands) {
            const cmd = commandSchema.safeParse(raw)
            if (!cmd.success) {
              return {
                type: 'error-text',
                value: `Invalid store command: ${cmd.error.message.slice(0, 400)}`,
              }
            }
            validated.push(cmd.data)
          }
          const ok = store.getState().dispatchMany(validated, parsed.data.summary)
          if (!ok) {
            return { type: 'error-text', value: 'The commands produced no changes.' }
          }
          push(storeChange(store, parsed.data.summary))
          return {
            type: 'text',
            value: JSON.stringify({
              applied: true,
              count: validated.length,
              summary: parsed.data.summary,
            }),
          }
        }

        case 'generateStoreCopy': {
          const parsed = copyInputSchema.safeParse(call.input ?? {})
          if (!parsed.success) {
            return { type: 'error-text', value: `Invalid copy options: ${parsed.error.message}` }
          }
          const state = store.getState()
          const doc = state.document
          const brief = parsed.data.brief || doc.productBrief
          if (!brief.trim()) {
            return {
              type: 'error-text',
              value:
                'No product brief is set on this project yet. Call getProduct first or pass a brief.',
            }
          }
          const targetLocale = parsed.data.locale || state.locale
          const slides =
            parsed.data.scope === 'active'
              ? doc.slides.filter((slide) => slide.id === state.activeSlideId)
              : doc.slides.slice(0, 12)
          const headlineOf = (slideId: string) => {
            const layer = doc.slides
              .find((slide) => slide.id === slideId)
              ?.layers.find(
                (item): item is TextLayer => item.type === 'text' && item.role === 'heading'
              )
            return layer ? layer.content.map((span) => span.text).join('') : ''
          }
          try {
            const result = await requestJson<{
              slides: Array<{
                id: string
                suggestions: Array<{ headline: string; subheadline: string }>
              }>
            }>('/api/store-screenshots/copy', {
              body: {
                brief,
                count: parsed.data.count,
                length: parsed.data.length,
                locale: targetLocale,
                slides: slides.map((slide) => ({
                  currentHeadline: headlineOf(slide.id),
                  id: slide.id,
                  topic: slide.name,
                })),
                tone: parsed.data.tone,
              },
              signal,
            })
            const suggestions = result.slides.flatMap((slide) =>
              slide.suggestions.map((item) => ({
                headline: item.headline,
                id: crypto.randomUUID(),
                locale: targetLocale,
                slideId: slide.id,
                subheadline: item.subheadline,
                tone: parsed.data.tone,
              }))
            )
            if (suggestions.length > 0) {
              store.getState().dispatch({ suggestions, type: 'copy.remember' })
              push(storeChange(store, `Generated ${suggestions.length} headline suggestions`))
            }
            return {
              type: 'text',
              value: JSON.stringify({
                count: suggestions.length,
                slides: result.slides,
              }),
            }
          } catch (error) {
            return {
              type: 'error-text',
              value: `Could not generate store copy: ${error instanceof Error ? error.message : 'unknown'}`,
            }
          }
        }

        case 'translateStoreLocales': {
          const parsed = translateInputSchema.safeParse(call.input ?? {})
          if (!parsed.success) {
            return { type: 'error-text', value: 'Invalid locales list.' }
          }
          const doc = store.getState().document
          const { locales, sourceLocale } = doc.localization
          const targets =
            parsed.data.locales && parsed.data.locales.length > 0
              ? parsed.data.locales.filter((code) => locales.includes(code))
              : locales
          if (targets.length === 0) {
            return {
              type: 'error-text',
              value: 'No target locales are configured on this store project yet.',
            }
          }
          const requests = pendingTranslations(doc, targets, {
            includeApproved: false,
            includeCurrent: false,
          })
          if (requests.length === 0) {
            return { type: 'text', value: 'All configured locales are already translated.' }
          }
          const layerById = new Map(
            doc.slides.flatMap((slide) =>
              slide.layers
                .filter((layer): layer is TextLayer => layer.type === 'text')
                .map((layer) => [layer.id, layer])
            )
          )
          const byLocale = new Map<string, typeof requests>()
          for (const req of requests) {
            byLocale.set(req.locale, [...(byLocale.get(req.locale) ?? []), req])
          }
          let translatedCount = 0
          let steps = 0
          const done = new Set<string>()
          try {
            for (const [targetLocale, list] of byLocale) {
              for (let start = 0; start < list.length; start += 60) {
                const chunk = list.slice(start, start + 60)
                const { translations } = await requestJson<{
                  translations: Array<{ id: string; text: string }>
                }>('/api/store-screenshots/translate', {
                  body: {
                    context: doc.productBrief,
                    items: chunk.map((req) => ({
                      id: req.layerId,
                      text: encodeSpans(req.source),
                    })),
                    sourceLocale,
                    targetLocale,
                  },
                  signal,
                })
                const translated = new Map(translations.map((item) => [item.id, item.text]))
                const entries = chunk.flatMap((req) => {
                  const text = translated.get(req.layerId)
                  if (!text) return []
                  const source = layerById.get(req.layerId)?.content ?? req.source
                  return [
                    {
                      content: decodeSpans(text, source),
                      layerId: req.layerId,
                      locale: targetLocale,
                      slideId: req.slideId,
                      status: 'machine' as const,
                    },
                  ]
                })
                // Saved per chunk, so a later failure or Stop keeps what was already paid for.
                signal?.throwIfAborted()
                if (entries.length > 0) {
                  store.getState().dispatch({ entries, type: 'text.translate' })
                  translatedCount += entries.length
                  steps += 1
                  done.add(targetLocale)
                }
              }
            }
            return {
              type: 'text',
              value: JSON.stringify({ locales: [...done], translatedCount }),
            }
          } catch (error) {
            signal?.throwIfAborted()
            return {
              type: 'error-text',
              value: `Translation failed after ${translatedCount} entries (locales done: ${[...done].join(', ') || 'none'}): ${error instanceof Error ? error.message : 'unknown'}`,
            }
          } finally {
            if (translatedCount > 0) {
              push(
                storeChange(
                  store,
                  `Translated ${translatedCount} text entries across ${done.size} locale${done.size === 1 ? '' : 's'}`,
                  steps
                )
              )
            }
          }
        }

        default:
          return { type: 'error-text', value: `Unknown tool ${call.toolName}.` }
      }
    },
    [store]
  )

  useAssistantAbility(
    {
      id: `store-screenshots:${projectId}`,
      label: `Store set · ${projectName}`,
      placeholder: 'Ask to edit slides, write App Store headlines, or translate locales…',
      preferredMode: 'dock',
      priority: 10,
      quickActions: [...STORE_QUICK_ACTIONS],
      run: (run) =>
        runUnifiedAssistant({
          ...run,
          clientTools: STORE_CLIENT_TOOLS,
          executeClientTool,
        }),
      selection: activeSlideName ? `Slide “${activeSlideName}”` : null,
      suggestions: STORE_SUGGESTIONS,
      surface: 'store-screenshots',
    },
    active
  )

  const facts = useMemo(
    () => [
      `App Store / Play Store screenshot set "${projectName}" with ${slideCount} slide${slideCount === 1 ? '' : 's'}.`,
      `Active locale: ${locale} (${localeCount} total locale${localeCount === 1 ? '' : 's'}).`,
      activeSlideName ? `Active slide: "${activeSlideName}" (${activeSlideId}).` : 'No active slide.',
      `Compliance checks: ${issueCount.requirements} required issue${issueCount.requirements === 1 ? '' : 's'}, ${issueCount.recommendations} recommendation${issueCount.recommendations === 1 ? '' : 's'}.`,
    ],
    [
      activeSlideId,
      activeSlideName,
      issueCount.recommendations,
      issueCount.requirements,
      locale,
      localeCount,
      projectName,
      slideCount,
    ]
  )

  useAssistantPage(
    {
      entities: [{ id: projectId, name: projectName, type: 'store-project' }],
      facts,
    },
    active
  )
}
