'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { usePathname, useSearchParams } from 'next/navigation'
import { ArrowUpIcon } from '@phosphor-icons/react/dist/ssr/ArrowUp'
import { MicrophoneIcon } from '@phosphor-icons/react/dist/ssr/Microphone'
import { MinusIcon } from '@phosphor-icons/react/dist/ssr/Minus'
import { SidebarSimpleIcon } from '@phosphor-icons/react/dist/ssr/SidebarSimple'
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { StopIcon } from '@phosphor-icons/react/dist/ssr/Stop'
import { TargetIcon } from '@phosphor-icons/react/dist/ssr/Target'
import { XIcon } from '@phosphor-icons/react/dist/ssr/X'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { useKeys } from '@/components/write/shortcuts'
import { useVoiceDictation } from '@/hooks/use-voice-dictation'
import { EDITOR_ASK_MAX, EDITOR_ASK_PARAM } from '@/lib/ai/editor-ask'
import {
  ASSISTANT_ASK_MAX,
  type AssistantAbility,
  type AssistantEntry,
  type AssistantPresentationMode,
} from '@/lib/assistant/ability'
import type { PageContext } from '@/lib/assistant/page-context'
import { savedEntries } from '@/lib/assistant/saved-thread'
import { tierRequiresApiKey } from '@/lib/ai/models/tiers'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'
import { toast } from 'sonner'
import { ATTACHMENTS_MAX } from '@/lib/assistant/attachments'
import { platformArea } from '@/lib/platform/navigation'
import { withoutLocale } from '@/lib/settings/appearance'
import { cn } from '@/lib/utils'
import {
  closeAssistant,
  loadStoredAssistantMode,
  openAssistant,
  pushAssistantEntry,
  queueChatWrite,
  setAssistantMode,
  setAssistantModelOverride,
  startAssistantOver,
  syncAssistantOrganization,
  toggleAssistant,
  updateAssistantActivity,
  useAssistantStore,
} from './assistant-store'
import { AssistantContextRibbon } from './AssistantContextRibbon'
import { AssistantMark } from './AssistantMark'
import { AssistantThreads } from './AssistantThreads'
import { AssistantAttach, prepareImageFile } from './AssistantAttach'
import { AssistantMessage, AssistantPending, scrollThreadIfPinned } from './AssistantMessage'
import { useAssistantRegistry } from './AssistantProvider'
import { useAiAvailable } from './useAiAvailable'
import { workspaceAbility } from './workspace-ability'

/** Most suggested asks shown in the empty state. */
const SUGGESTIONS_MAX = 4

/** The tab's title without the product name, as the page's name. */
function pageTitle(): string {
  return document.title.replace(/\s*[|·–-]\s*Shots\s*$/, '').trim()
}

/**
 * The unified Shots AI assistant rendered across every platform page and editor.
 * Supports both Compact Floating Bar (`mode="bar"`) and Docked Side Inspector
 * (`mode="dock"`) with one-click switching, rich interactive artifact cards,
 * quick actions, selection scoping, and workspace + surface tool composition.
 */
export function AssistantBar({
  canEdit,
  organizationId = null,
  paidPlan,
  posts,
}: {
  /** The member may make work, so the assistant offers asks that start some. */
  canEdit: boolean
  /** Active workspace organization id; switching resets thread memory cleanly. */
  organizationId?: string | null
  paidPlan: boolean
  /** Posts are on, and on the workspace's plan. */
  posts: boolean
}) {
  const registry = useAssistantRegistry()
  const available = useAiAvailable()
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const path = withoutLocale(usePathname())
  const searchParams = useSearchParams()
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [images, setImages] = useState<{ name: string; data: string }[]>([])
  const [draggingOver, setDraggingOver] = useState(false)

  const dictation = useVoiceDictation({
    onTranscript: (transcript) => {
      setText((current) => `${current} ${transcript}`.trim().slice(0, ASSISTANT_ASK_MAX))
      input.current?.focus()
    },
  })

  useEffect(() => {
    const stored = loadStoredAssistantMode()
    if (stored && useAssistantStore.getState().modeOverride === null) {
      useAssistantStore.setState({ modeOverride: stored })
    }
  }, [])

  const entries = useAssistantStore((state) => state.entries)
  const open = useAssistantStore((state) => state.open)
  const running = useAssistantStore((state) => state.controller !== null)
  const conversationAbility = useAssistantStore((state) => state.abilityId)
  const modeOverride = useAssistantStore((state) => state.modeOverride)
  const focus = useAssistantStore((state) => state.focus)
  const scopeEnabled = useAssistantStore((state) => state.scopeEnabled)

  const thread = useRef<HTMLOListElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  // Reset conversation memory, local attachments/draft, and dictation whenever workspace changes.
  const cancelDictation = dictation.cancel
  useEffect(() => {
    const previous = useAssistantStore.getState().organizationId
    syncAssistantOrganization(organizationId)
    if (previous !== null && previous !== organizationId) {
      setText('')
      setImages([])
      cancelDictation()
    }
  }, [cancelDictation, organizationId])

  // Stop any live microphone recording if the assistant is hidden or AI becomes unavailable.
  useEffect(() => {
    if (!open || !available) cancelDictation()
  }, [available, cancelDictation, open])

  // Next sets the title after navigating; follow it.
  useEffect(() => {
    setTitle(pageTitle())
    const head = document.querySelector('title')
    if (!head) return
    const observer = new MutationObserver(() => setTitle(pageTitle()))
    observer.observe(head, { childList: true })
    return () => observer.disconnect()
  }, [path])

  const area = platformArea(path)
  const registered = [...(registry?.abilities.values() ?? [])]
  const ability: AssistantAbility = registered.reduce<AssistantAbility>(
    (best, item) => (item.priority > best.priority ? item : best),
    workspaceAbility(title, area, { canEdit, paidPlan, posts })
  )

  const mode: AssistantPresentationMode = modeOverride ?? ability.preferredMode ?? 'bar'
  const activeSelection = ability.selection && scopeEnabled ? ability.selection : null

  // Re-enable scope automatically when a new element is selected on the canvas.
  const previousSelection = useRef<string | null>(null)
  useEffect(() => {
    const next = ability.selection ?? null
    if (next && next !== previousSelection.current) {
      useAssistantStore.setState({ scopeEnabled: true })
    }
    previousSelection.current = next
  }, [ability.selection])

  // A different ability starts its own conversation (a running one is stopped first,
  // so it cannot change the surface the person moved to), preserves any persisted
  // Dock/Bar preference, and opens automatically when prominent.
  const prominent = ability.prominent === true
  useEffect(() => {
    if (conversationAbility === ability.id) return
    if (running) {
      useAssistantStore.getState().controller?.abort()
      return
    }
    startAssistantOver(ability.id)
    useAssistantStore.setState({
      modeOverride: loadStoredAssistantMode(),
      open: prominent,
    })
  }, [ability.id, conversationAbility, prominent, running])

  useEffect(() => {
    scrollThreadIfPinned(thread.current)
  }, [entries, running])

  // Keep the multiline composer height sized tightly to its content.
  useEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`
  }, [text, open, mode])

  // Move focus into the composer whenever a trigger opens the assistant.
  useEffect(() => {
    if (focus && open) input.current?.focus()
  }, [focus, open])

  // ⌘J (Ctrl+J) opens the assistant from anywhere; a closer Ask AI (e.g. post composer) wins.
  const shown = Boolean(registry?.slot && available)
  useEffect(() => {
    if (!shown) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      // `code` too, so the shortcut holds on non-Latin keyboard layouts.
      if (event.defaultPrevented || (event.key.toLowerCase() !== 'j' && event.code !== 'KeyJ'))
        return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      // A rich-text editor (the post composer, Plate) keeps ⌘J for its own Ask AI.
      if (event.target instanceof HTMLElement && event.target.isContentEditable) return
      event.preventDefault()
      openAssistant()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown])

  // `?ask=` opens the assistant holding a request (e.g. "Start this visual" / "Edit with AI");
  // waits until `?start` clears on new-project boot so the editor finishes resetting first.
  const waitingForStart = searchParams.has('start')
  const askParam = searchParams.get(EDITOR_ASK_PARAM)?.trim().slice(0, EDITOR_ASK_MAX) ?? ''
  // A page's request to open with text ready (a saved prompt a draft was opened with).
  // Applied after the ability's own conversation starts, which would otherwise close the bar.
  const prefill = useAssistantStore((state) => state.prefill)
  useEffect(() => {
    if (!shown || !prefill) return
    if (prefill.abilityId !== '*' && prefill.abilityId !== ability.id) return
    if (conversationAbility !== ability.id) return
    useAssistantStore.setState({ prefill: null })
    setText(prefill.text.slice(0, ASSISTANT_ASK_MAX))
    openAssistant()
  }, [ability.id, conversationAbility, prefill, shown])

  const askedRef = useRef('')
  useEffect(() => {
    if (!askParam) askedRef.current = ''
    if (!shown || waitingForStart || !askParam || askedRef.current === askParam) return
    askedRef.current = askParam
    setText(askParam)
    openAssistant()
    const url = new URL(window.location.href)
    url.searchParams.delete(EDITOR_ASK_PARAM)
    window.history.replaceState(null, '', url)
  }, [askParam, shown, waitingForStart])

  const buildPageContext = useCallback((): PageContext => {
    const clip = (value: string, max: number) => value.slice(0, max)
    const parts = [...(registry?.parts.values() ?? [])]
    return {
      area: clip(area ?? path.split('/')[1] ?? 'home', 40),
      entities: parts
        .flatMap((part) => part.entities ?? [])
        .slice(0, 8)
        .map((entity) => ({
          id: clip(entity.id, 80),
          type: clip(entity.type, 40),
          ...(entity.name ? { name: clip(entity.name, 200) } : {}),
        })),
      facts: parts
        .flatMap((part) => part.facts ?? [])
        .slice(0, 12)
        .map((fact) => clip(fact, 300)),
      path: clip(path, 300),
      ...(activeSelection ? { selection: clip(activeSelection, 200) } : {}),
      ...(ability.surface ? { surface: ability.surface } : {}),
      title: clip(pageTitle() || title, 200),
    }
  }, [ability.surface, activeSelection, area, path, registry, title])

  const send = useCallback(
    async (value: string, overrideImages?: readonly string[]) => {
      if (dictation.state !== 'idle') return
      const attached = overrideImages ? [...overrideImages] : images.map((image) => image.data)
      const ask = (
        value.trim() || (attached.length > 0 ? 'Inspect this image and help me with it.' : '')
      ).slice(0, ASSISTANT_ASK_MAX)
      if (!ask || useAssistantStore.getState().controller !== null) return
      if (useAssistantStore.getState().abilityId !== ability.id) startAssistantOver(ability.id)
      const controller = new AbortController()
      useAssistantStore.setState({ controller, statusLabel: '' })
      pushAssistantEntry({ kind: 'user', text: ask })
      const memory = useAssistantStore.getState().memory
      if (!overrideImages) setImages([])
      // A run that outlives its thread (a workspace switch) adds nothing to the next one.
      const push = (entry: AssistantEntry) =>
        useAssistantStore.getState().memory === memory ? pushAssistantEntry(entry) : undefined
      const updateActivity = (id: number, next: 'running' | 'done' | 'error') => {
        if (useAssistantStore.getState().memory === memory) updateAssistantActivity(id, next)
      }
      try {
        const currentStore = useAssistantStore.getState()
        await ability.run({
          ask,
          ...(currentStore.contextRefs.length > 0
            ? { contextRefs: currentStore.contextRefs }
            : {}),
          ...(currentStore.effortOverride ? { effort: currentStore.effortOverride } : {}),
          memory,
          ...(currentStore.modelTierOverride ? { modelTier: currentStore.modelTierOverride } : {}),
          ...(attached.length > 0 ? { images: attached } : {}),
          page: buildPageContext(),
          push,
          status: (statusLabel) => {
            if (useAssistantStore.getState().memory === memory)
              useAssistantStore.setState({ statusLabel })
          },
          stream: (draft) => {
            if (useAssistantStore.getState().memory === memory) useAssistantStore.setState({ draft })
          },
          selection: activeSelection,
          signal: controller.signal,
          updateActivity,
        })
      } catch (error) {
        const message = controller.signal.aborted
          ? 'Stopped.'
          : error instanceof Error
            ? error.message
            : 'Something went wrong.'
        const isApiKeyError = /OpenRouter API key/i.test(message)
        if (isApiKeyError) {
          const latest = useAssistantStore.getState()
          if (latest.modelTierOverride && tierRequiresApiKey(latest.modelTierOverride)) {
            setAssistantModelOverride(null, latest.effortOverride)
          }
          void queryClient.invalidateQueries({ queryKey: trpc.workspace.readiness.queryKey() })
        }
        const isCreditError = !isApiKeyError && /credit|quota|billing/i.test(message)
        const hasTextPrompt = value.trim().length > 0
        push({
          ...(isApiKeyError
            ? { actionHref: '/settings/ai-models', actionLabel: 'Manage AI models' }
            : isCreditError
              ? { actionHref: '/settings/billing', actionLabel: 'View billing & credits' }
              : {}),
          kind: 'error',
          ...(!controller.signal.aborted && hasTextPrompt ? { retryAsk: ask } : {}),
          text: message,
        })
      } finally {
        if (useAssistantStore.getState().controller === controller)
          useAssistantStore.setState({ controller: null, statusLabel: '' })
        const state = useAssistantStore.getState()
        const kept = savedEntries(state.entries)
        if (state.memory === memory && kept.length > 0) {
          const id = state.threadId ?? crypto.randomUUID()
          useAssistantStore.setState({ threadId: id })
          const title = kept.find((entry) => entry.kind === 'user')?.text.slice(0, 120) ?? ask
          // The chat works without being saved, so a failure only says so.
          void queueChatWrite(() =>
            client.assistantThread.save.mutate({
              entries: kept,
              id,
              title: title.trim().slice(0, 120) || 'Chat',
            })
          ).catch(() => toast.error('This chat could not be saved.', { id: 'assistant-save' }))
        }
      }
    },
    [
      ability,
      activeSelection,
      buildPageContext,
      client,
      dictation.state,
      images,
      queryClient,
      trpc.workspace.readiness,
    ]
  )

  const addImageFiles = useCallback(async (files: readonly File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/')).slice(0, ATTACHMENTS_MAX)
    if (imageFiles.length === 0) return
    try {
      const prepared = await Promise.all(imageFiles.map((file) => prepareImageFile(file)))
      setImages((current) => [...current, ...prepared].slice(-ATTACHMENTS_MAX))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That image could not be attached.')
    }
  }, [])

  const onComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = [...event.clipboardData.items]
      const files = items
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
      if (files.length === 0) return
      event.preventDefault()
      void addImageFiles(files)
    },
    [addImageFiles]
  )

  const onPanelDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault()
      setDraggingOver(false)
      const files = [...event.dataTransfer.files]
      if (files.length > 0) void addImageFiles(files)
    },
    [addImageFiles]
  )

  const onPanelDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setDraggingOver(true)
  }, [])

  const onPanelDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDraggingOver(false)
    }
  }, [])

  if (!registry || !available || !registry.slot) return null

  const canSend = (text.trim().length > 0 || images.length > 0) && dictation.state === 'idle'

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSend || running) return
    const next = text
    setText('')
    void send(next)
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && !running && (mode === 'dock' || !prominent)) {
      closeAssistant()
      return
    }
    if (event.key === 'ArrowUp' && !text) {
      const last = entries.findLast((entry) => entry.kind === 'user')
      if (last && 'text' in last) {
        event.preventDefault()
        setText(last.text)
      }
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (!canSend || running) return
      const next = text
      setText('')
      void send(next)
    }
  }

  const lastChange = entries.findLast((entry) => entry.kind === 'change')
  const suggestions = entries.length ? [] : (ability.suggestions ?? []).slice(0, SUGGESTIONS_MAX)
  const quickActions = ability.quickActions ?? []
  const canHide = mode === 'dock' || !prominent
  const toggleMode = () => setAssistantMode(mode === 'dock' ? 'bar' : 'dock')

  const headerControls = (
    <div className="ms-auto flex items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={mode === 'dock' ? 'Switch to floating bar' : 'Dock to side panel'}
        title={mode === 'dock' ? 'Switch to floating bar' : 'Dock to side panel'}
        className="size-7 rounded-full p-0 text-muted-foreground hover:text-foreground"
        onClick={toggleMode}
      >
        <SidebarSimpleIcon
          className="size-3.5"
          aria-hidden="true"
          weight={mode === 'dock' ? 'fill' : 'regular'}
        />
      </Button>
      <AssistantThreads abilityId={ability.id} disabled={running} />
      {entries.length > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 rounded-full px-2.5 text-xs"
          disabled={running}
          onClick={() => startAssistantOver(ability.id)}
        >
          New chat
        </Button>
      ) : null}
      {canHide ? (
        <Button
          type="button"
          size={null}
          variant="custom"
          aria-label="Hide the assistant"
          title="Hide the assistant"
          className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          onClick={closeAssistant}
        >
          <MinusIcon className="size-3.5" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  )

  const scopeChip = ability.selection ? (
    <div className="flex items-center gap-1.5 px-1 text-[0.71875rem]">
      {scopeEnabled ? (
        <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-foreground/15 bg-foreground/[0.05] px-2.5 py-0.5 text-foreground/85">
          <TargetIcon className="size-3 shrink-0 opacity-70" aria-hidden="true" />
          <span className="truncate">Scoped: {ability.selection}</span>
          <Button
            type="button"
            variant="custom"
            size={null}
            aria-label="Clear selection scope"
            className="ms-0.5 grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            onClick={() => useAssistantStore.setState({ scopeEnabled: false })}
          >
            <XIcon className="size-2.5" aria-hidden="true" />
          </Button>
        </span>
      ) : (
        <Button
          type="button"
          variant="custom"
          size={null}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-foreground/15 px-2.5 py-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => useAssistantStore.setState({ scopeEnabled: true })}
        >
          <TargetIcon className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">Scope to {ability.selection}</span>
        </Button>
      )}
    </div>
  ) : null

  const helpers =
    ability.prompts || ability.setupLink ? (
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 text-xs',
          mode === 'dock' ? 'px-3 pt-2' : 'justify-center'
        )}
      >
        {ability.prompts ? (
          <Select value="" onValueChange={(value) => {
            setText(value.slice(0, ASSISTANT_ASK_MAX))
            input.current?.focus()
          }}>
            <SelectTrigger aria-label="Prompt library" className="w-auto bg-card" size="sm">
              <SelectValue placeholder="Prompts" />
            </SelectTrigger>
            <SelectContent className="max-w-80">
              {ability.prompts.map((prompt) => (
                <SelectItem key={prompt.label} value={prompt.text}>
                  {prompt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {ability.setupLink ? (
          <SidebarLink
            href={ability.setupLink.href}
            className="rounded-full bg-card px-2 py-1 text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {ability.setupLink.label}
          </SidebarLink>
        ) : null}
      </div>
    ) : null

  const quickActionStrip = quickActions.length > 0 ? (
    <div
      role="group"
      aria-label="Quick actions"
      className={cn(
        'flex flex-wrap gap-1.5',
        mode === 'dock' ? 'border-b border-foreground/[0.08] px-3 py-2' : 'justify-center'
      )}
    >
      {quickActions.map((action) => (
        <Button
          key={action.id}
          type="button"
          variant="custom"
          size={null}
          disabled={running}
          title={action.description ?? action.prompt}
          className="assistant-quick-action"
          onClick={() => void send(action.prompt)}
        >
          {action.label}
        </Button>
      ))}
    </div>
  ) : null

  const attachmentChips = images.length ? (
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5 px-1">
      {images.map((image, index) => (
        <li
          key={`${image.name}-${index}`}
          className="inline-flex max-w-52 items-center gap-1.5 rounded-lg border border-foreground/15 bg-card p-1 pe-1.5 text-[0.71875rem]"
        >
          <img
            src={`data:image/jpeg;base64,${image.data}`}
            alt={image.name}
            className="size-7 shrink-0 rounded object-cover"
          />
          <span className="truncate">{image.name}</span>
          <Button
            type="button"
            variant="custom"
            size={null}
            aria-label={`Remove ${image.name}`}
            className="grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            onClick={() => setImages((current) => current.filter((_, at) => at !== index))}
          >
            <XIcon className="size-2.5" aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ul>
  ) : null

  const formatTimer = (total: number) =>
    `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`

  const voiceControl = canEdit && dictation.supported ? (
    dictation.state === 'recording' ? (
      <div className="inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
        <span className="size-1.5 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
        <span className="tabular-nums">{formatTimer(dictation.seconds)}</span>
        <Button
          type="button"
          size={null}
          variant="custom"
          aria-label="Finish voice dictation"
          title="Finish & transcribe"
          className="grid size-5 place-items-center rounded-full bg-destructive text-destructive-foreground"
          onClick={dictation.stop}
        >
          <StopIcon className="size-2.5" aria-hidden="true" weight="fill" />
        </Button>
        <Button
          type="button"
          size={null}
          variant="custom"
          aria-label="Cancel voice dictation"
          title="Cancel recording"
          className="grid size-5 place-items-center rounded-full text-destructive/80 hover:text-destructive"
          onClick={dictation.cancel}
        >
          <XIcon className="size-2.5" aria-hidden="true" />
        </Button>
      </div>
    ) : (
      <Button
        type="button"
        size={null}
        variant="custom"
        aria-label="Dictate with microphone"
        title={
          dictation.state === 'transcribing'
            ? 'Transcribing voice…'
            : 'Dictate prompt with microphone (uses AI credits)'
        }
        disabled={running || dictation.state === 'transcribing'}
        className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground disabled:opacity-40"
        onClick={() => void dictation.start()}
      >
        {dictation.state === 'transcribing' ? (
          <SpinnerGapIcon className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <MicrophoneIcon className="size-3.5" aria-hidden="true" />
        )}
      </Button>
    )
  ) : null

  const composer = (
    <form
      onSubmit={submit}
      className={cn(
        'assistant-bar',
        mode === 'dock' && 'assistant-bar-dock',
        draggingOver && 'ring-2 ring-ring/50'
      )}
    >
      {mode === 'bar' ? (
        <>
          <AssistantMark className="-mx-px shrink-0" />
          <span className="assistant-context" title={`The assistant sees: ${ability.label}`}>
            {ability.label}
          </span>
        </>
      ) : null}
      <AssistantAttach
        onImage={(image) => setImages((current) => [...current, image].slice(-ATTACHMENTS_MAX))}
        onTranscript={(transcript) =>
          setText((current) => `${current} ${transcript}`.trim().slice(0, ASSISTANT_ASK_MAX))
        }
      />
      <Textarea
        ref={input}
        data-assistant-composer
        aria-label="Ask the assistant"
        placeholder={ability.placeholder}
        value={text}
        rows={1}
        maxLength={ASSISTANT_ASK_MAX}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onComposerKeyDown}
        onPaste={onComposerPaste}
        className="assistant-textarea"
      />
      {voiceControl}
      {running ? (
        <Button
          type="button"
          size={null}
          variant="custom"
          aria-label="Stop"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background"
          onClick={() => useAssistantStore.getState().controller?.abort()}
        >
          <StopIcon className="size-3.5" aria-hidden="true" weight="fill" />
        </Button>
      ) : (
        <Button
          type="submit"
          size={null}
          variant="custom"
          aria-label="Send"
          disabled={!canSend}
          className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-30"
        >
          <ArrowUpIcon className="size-4" aria-hidden="true" />
        </Button>
      )}
      {mode === 'bar' && entries.length === 0 ? (
        <>
          <AssistantThreads abilityId={ability.id} disabled={running} />
          <Button
            type="button"
            size={null}
            variant="custom"
            aria-label="Dock to side panel"
            title="Dock to side panel"
            className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"
            onClick={toggleMode}
          >
            <SidebarSimpleIcon className="size-3.5" aria-hidden="true" />
          </Button>
          {canHide ? (
            <Button
              type="button"
              size={null}
              variant="custom"
              aria-label="Hide the assistant"
              className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"
              onClick={closeAssistant}
            >
              <MinusIcon className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </>
      ) : null}
    </form>
  )

  const panel = open ? (
    mode === 'dock' ? (
      <section
        aria-label="Assistant"
        data-board-control
        data-export-exclude
        data-mode="dock"
        onDragLeave={onPanelDragLeave}
        onDragOver={onPanelDragOver}
        onDrop={onPanelDrop}
        className={cn('assistant assistant-dock', draggingOver && 'ring-2 ring-ring/40')}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-foreground/[0.08] px-3 py-2.5 text-[0.8125rem]">
          <AssistantMark className="shrink-0" />
          <span className="font-semibold tracking-tight">Shots</span>
          <span
            className="assistant-context"
            title={`The assistant sees: ${ability.label}`}
          >
            {ability.label}
          </span>
          {headerControls}
        </header>
        {helpers}
        {quickActionStrip}
        <ol
          ref={thread}
          aria-live="polite"
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3"
        >
          {entries.length === 0 ? (
            <li className="space-y-3 py-2 text-[0.8125rem] text-muted-foreground">
              <p>
                {ability.surface === 'screenshot-editor'
                  ? 'Ask me to edit this design directly, apply your brand kit, review layout and contrast, generate variants or captions, or look up anything in your workspace. Every canvas edit is one ⌘Z.'
                  : 'Ask me about what is open here, or look up anything in your workspace.'}
              </p>
              {suggestions.length > 0 ? (
                <div
                  role="group"
                  aria-label="Suggestions"
                  className="flex flex-wrap gap-1.5"
                >
                  {suggestions.map((suggestion) => (
                    <Button
                      key={suggestion}
                      type="button"
                      variant="custom"
                      size={null}
                      className="assistant-suggestion"
                      disabled={running}
                      onClick={() => void send(suggestion)}
                    >
                      {suggestion}
                    </Button>
                  ))}
                </div>
              ) : null}
            </li>
          ) : (
            entries.map((entry) => (
              <AssistantMessage
                key={entry.id}
                entry={entry}
                canUndo={!running && entry === lastChange}
                onRetry={(prompt) => void send(prompt, [])}
                target={ability.target}
              />
            ))
          )}
          {running ? (
            <AssistantPending thread={thread} />
          ) : null}
        </ol>
        <div className="shrink-0 space-y-1.5 border-t border-foreground/[0.08] p-2.5">
          {attachmentChips}
          {scopeChip}
          <AssistantContextRibbon disabled={running} mode="dock" surface={ability.surface} />
          {composer}
        </div>
      </section>
    ) : (
      <section
        aria-label="Assistant"
        data-board-control
        data-export-exclude
        data-mode="bar"
        onDragLeave={onPanelDragLeave}
        onDragOver={onPanelDragOver}
        onDrop={onPanelDrop}
        className="assistant"
      >
        {entries.length > 0 ? (
          <div className="assistant-thread">
            <header className="flex items-center gap-2 border-b px-3 py-2 text-[0.78125rem]">
              <span className="font-medium">Shots</span>
              <span className="truncate text-muted-foreground">{ability.label}</span>
              {headerControls}
            </header>
            <ol
              ref={thread}
              aria-live="polite"
              className="grid max-h-[38vh] gap-2 overflow-y-auto p-3"
            >
              {entries.map((entry) => (
                <AssistantMessage
                  key={entry.id}
                  entry={entry}
                  canUndo={!running && entry === lastChange}
                  onRetry={(prompt) => void send(prompt, [])}
                  target={ability.target}
                />
              ))}
              {running ? (
                <AssistantPending thread={thread} />
              ) : null}
            </ol>
          </div>
        ) : null}
        {helpers}
        {quickActionStrip}
        {suggestions.length > 0 ? (
          <div role="group" aria-label="Suggestions" className="assistant-suggestions">
            {suggestions.map((suggestion) => (
              <Button
                key={suggestion}
                type="button"
                variant="custom"
                size={null}
                className="assistant-suggestion"
                disabled={running}
                onClick={() => void send(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        ) : null}
        {attachmentChips}
        {scopeChip}
        <AssistantContextRibbon disabled={running} mode="bar" surface={ability.surface} />
        {composer}
      </section>
    )
  ) : null

  return panel ? createPortal(panel, registry.slot) : null
}

/**
 * "Ask AI" in the sidebar: opens (or toggles) the unified Shots assistant on
 * every page and editor route, focusing its composer.
 */
export function AssistantLauncher({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean
  /** Closes the phone menu the launcher sits in. */
  onNavigate?: () => void
}) {
  const registry = useAssistantRegistry()
  const available = useAiAvailable()
  const open = useAssistantStore((state) => state.open)
  const keys = useKeys()
  if (!registry?.slot || !available) return null
  return (
    <Button
      type="button"
      variant="custom"
      size={null}
      aria-label="Open the assistant"
      aria-expanded={open}
      title={`Ask AI about this page or your workspace (${keys.label({ key: 'j', mod: true })})`}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[0.84375rem] text-foreground/85 transition-colors hover:bg-foreground/[0.05] hover:text-foreground',
        open && 'bg-foreground/[0.06] text-foreground',
        collapsed && 'mx-auto size-10 justify-center px-0'
      )}
      onClick={() => {
        onNavigate?.()
        toggleAssistant()
      }}
    >
      <AssistantMark className="-mx-px shrink-0" />
      {collapsed ? null : 'Ask AI'}
    </Button>
  )
}
