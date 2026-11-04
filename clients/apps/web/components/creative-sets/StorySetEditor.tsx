'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { usePrivateCreativeSurface } from './use-private-surface'
import { useRouter } from 'next/navigation'
import { TRPCClientError } from '@trpc/client'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { DotsThreeIcon as MoreHorizontalIcon } from '@phosphor-icons/react/dist/ssr/DotsThree'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { CanvasStageShell } from '@/components/canvas/CanvasStageShell'
import ClientCanvas from '@/components/canvas/ClientCanvas'
const ComposePanel = dynamic(
  () => import('@/components/editor/panels/EditorPanel').then((module) => module.ComposePanel),
  { ssr: false }
)
const InspectorPanel = dynamic(
  () => import('@/components/editor/panels/EditorPanel').then((module) => module.InspectorPanel),
  { ssr: false }
)
import { ProjectPreview } from '@/components/projects/ProjectPreview'
import { useTRPCClient } from '@/lib/trpc/react'
import { useImageStore } from '@/lib/store'
import { brandKitLibrary, readBrandKit, type BrandKit } from '@/lib/brand/kit'
import { type SetCommand } from '@/lib/creative-sets/commands'
import { prepareSetBrand } from '@/lib/creative-sets/prepare-brand'
import {
  outputDimensions,
  storyForOutput,
  TREATMENTS,
  treatmentSchema,
  type ContentField,
  type CreativeSetDocument,
  type Treatment,
} from '@/lib/creative-sets/document'
import { CreativeSetSession } from '@/lib/creative-sets/session'
import {
  localTextBrandFields,
  resetTextBrandField,
  TEXT_BRAND_FIELDS,
} from '@/lib/creative-sets/brand'
import { NativeSetSession } from '@/lib/creative-sets/native-session'
import {
  readSetRecoveries,
  removeSetRecovery,
  type SetRecovery,
} from '@/lib/creative-sets/recovery'
import {
  ChangeComparison,
  EditStoryFocus,
  SetVersionHistory,
  SourceUpdate,
} from './StorySetChanges'
import { StorySetExport } from './StorySetExport'
import { StorySetIntake } from './StorySetIntake'
import { ImportProject } from './ImportProject'
const ImportStoreProject = dynamic(
  () => import('./ImportStoreProject').then((module) => module.ImportStoreProject),
  { ssr: false }
)
const StoreGroupEditor = dynamic(
  () => import('./StoreGroupEditor').then((module) => module.StoreGroupEditor),
  { ssr: false }
)
import { ReusableDialog } from './ReusableDialog'
import { ProposalDialog } from './ProposalDialog'
const MotionDeliveryDialog = dynamic(
  () => import('./MotionDeliveryDialog').then((module) => module.MotionDeliveryDialog),
  { ssr: false }
)
import { SetCollaborators } from './SetCollaborators'
import { CampaignHandoffDialog } from './CampaignHandoffDialog'
const TimelineEditor = dynamic(
  () => import('@/components/timeline/TimelineEditor').then((module) => module.TimelineEditor),
  { ssr: false }
)
import { applyStoryMotion, STORY_MOTION, storyMotionSchema } from '@/lib/creative-sets/motion'

export function StorySetEditor({
  setId,
  workspaceId,
  canEdit,
  canCreate,
  collabUrl,
  user,
}: {
  setId: string
  workspaceId: string
  canEdit: boolean
  canCreate: boolean
  collabUrl: string | null
  user: { id: string; name: string }
}) {
  usePrivateCreativeSurface()
  const client = useTRPCClient()
  const [session, setSession] = useState<CreativeSetSession | null>(null),
    [error, setError] = useState<string | null>(null)
  const [openError, setOpenError] = useState<'missing' | 'failed' | null>(null)
  const [retry, setRetry] = useState(0)
  const [recovery, setRecovery] = useState<SetRecovery | null>(null)
  useEffect(() => {
    setOpenError(null)
    setError(null)
    setSession(null)
    setRecovery(null)
    let active = true,
      instance: CreativeSetSession | null = null
    void (async () => {
      const record = await client.creativeSet.get.query({ creativeSetId: setId })
      if (!active) return
      instance = new CreativeSetSession(record, client)
      setSession(instance)
      if (canEdit) {
        try {
          const drafts = await readSetRecoveries(workspaceId, setId)
          const draft = drafts.find(
            (draft) => JSON.stringify(draft.document) !== JSON.stringify(record.document)
          )
          if (active && draft) setRecovery(draft)
        } catch {
          if (active) setError('Local recovery is unavailable. Cloud saving is still available.')
        }
      }
    })().catch((error) => {
      if (active)
        setOpenError(
          error instanceof TRPCClientError && error.data?.code === 'NOT_FOUND'
            ? 'missing'
            : 'failed'
        )
    })
    return () => {
      active = false
      instance?.dispose()
    }
  }, [client, setId, workspaceId, canEdit, retry])
  if (!session && openError)
    return (
      <main className="space-y-4 p-8">
        <h1 className="text-2xl font-semibold">
          {openError === 'missing' ? 'Story Set not found' : 'Could not open this Story Set'}
        </h1>
        <p role="alert" className="text-sm text-muted-foreground">
          {openError === 'missing'
            ? 'This link is unavailable in your current workspace.'
            : 'Please try again. If this set was saved by a newer version, update the app.'}
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="outline">
            <Link prefetch={false} href="/creative-sets">
              Back to Story Sets
            </Link>
          </Button>
          {openError === 'failed' ? (
            <Button onClick={() => setRetry((value) => value + 1)}>Retry</Button>
          ) : null}
        </div>
      </main>
    )
  return (
    <>
      {error ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {session ? (
        <SetWorkspace
          session={session}
          canEdit={canEdit}
          canCreate={canCreate}
          collabUrl={collabUrl}
          user={user}
        />
      ) : (
        <p className="p-12">Opening Story Set…</p>
      )}
      {session && recovery ? (
        <Dialog open>
          <DialogContent showCloseButton={false}>
            <DialogTitle>Recover unsaved work</DialogTitle>
            <DialogDescription>
              This device has a draft from {new Date(recovery.updatedAt).toLocaleString()}. It is
              based on revision {recovery.revision}; the saved set is at revision{' '}
              {session.snapshot().revision}.
            </DialogDescription>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  void removeSetRecovery(recovery.key).catch(() => undefined)
                  setRecovery(null)
                }}
              >
                Use saved version
              </Button>
              <Button
                onClick={() => {
                  session.recover(recovery)
                  setRecovery(null)
                }}
              >
                Recover draft
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}

function SetWorkspace({
  session,
  canEdit,
  canCreate,
  collabUrl,
  user,
}: {
  session: CreativeSetSession
  canEdit: boolean
  canCreate: boolean
  collabUrl: string | null
  user: { id: string; name: string }
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot)
  const router = useRouter()
  const [activeId, setActiveId] = useState(state.document.outputs[0]!.id)
  const active =
    state.document.outputs.find((output) => output.id === activeId) ?? state.document.outputs[0]!
  const story = storyForOutput(state.document, active)
  const storyOutputs = state.document.outputs.filter((output) => output.storyId === story.id)
  const [addingStory, setAddingStory] = useState(false)
  const [reusableOpen, setReusableOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [motionExport, setMotionExport] = useState(false)
  const [campaignOpen, setCampaignOpen] = useState(false)
  const [importingProject, setImportingProject] = useState(false)
  const [importingStore, setImportingStore] = useState(false)
  const [storeGroupId, setStoreGroupId] = useState<string | null>(null)
  const storeGroup = state.document.storeGroups.find((group) => group.id === storeGroupId)
  const storeFlush = useRef<(() => void) | null>(null)
  const registerStoreFlush = useCallback((flush: (() => void) | null) => {
    storeFlush.current = flush
  }, [])
  const selectedTextId = useImageStore((state) => state.selectedTextId)
  const [ready, setReady] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false),
    [history, setHistory] = useState(false),
    [source, setSource] = useState(false),
    [exporting, setExporting] = useState(false)
  const [focusOpen, setFocusOpen] = useState(false)
  const [kits, setKits] = useState<BrandKit[]>([])
  const [proposal, setProposal] = useState<{
    document: CreativeSetDocument
    before: CreativeSetDocument
    keptOverrides: number
  } | null>(null)
  const native = useRef<NativeSetSession | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const flushActive = useCallback(() => {
    try {
      native.current?.flush()
      storeFlush.current?.()
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Correct this edit before switching formats.'
      )
      throw error
    }
  }, [])
  useEffect(() => {
    let pointing = false
    const start = () => {
      pointing = true
    }
    const end = () => {
      pointing = false
    }
    const timer = setInterval(() => {
      if (
        pointing ||
        document.activeElement?.closest('input,textarea,[contenteditable="true"],[role="dialog"]')
      )
        return
      void session.refreshRemote(flushActive)
    }, 1500)
    window.addEventListener('pointerdown', start, true)
    window.addEventListener('pointerup', end, true)
    window.addEventListener('pointercancel', end, true)
    window.addEventListener('blur', end)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pointerdown', start, true)
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('pointercancel', end, true)
      window.removeEventListener('blur', end)
    }
  }, [session, flushActive])
  useEffect(() => {
    if (storeGroupId) {
      setReady(true)
      return
    }
    if (!canEdit) return
    const bridge = new NativeSetSession(session, activeId)
    native.current = bridge
    setReady(false)
    setError(null)
    void bridge
      .open()
      .then(() => {
        if (native.current === bridge) setReady(true)
      })
      .catch((error) => {
        if (native.current === bridge)
          setError(error instanceof Error ? error.message : 'Canvas loading failed.')
      })
    return () => {
      bridge.close()
      if (native.current === bridge) native.current = null
    }
  }, [session, activeId, state.loadEpoch, canEdit, storeGroupId])
  useEffect(() => {
    let active = true
    void session.client.brandKit.list
      .query()
      .then(({ brandKits }) => {
        if (active) setKits(brandKitLibrary(brandKits))
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [session])
  useEffect(() => {
    if (!canEdit) return
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('input,textarea,[contenteditable="true"],[role="dialog"]')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        flushActive()
        if (event.shiftKey) session.redo()
        else session.undo()
      }
    }
    const leave = (event: BeforeUnloadEvent) => {
      let failed = false
      try {
        flushActive()
      } catch {
        failed = true
      }
      if (failed || session.snapshot().status !== 'saved') {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('beforeunload', leave)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('beforeunload', leave)
    }
  }, [session, canEdit, flushActive])
  function run(command: SetCommand) {
    try {
      flushActive()
      session.command(command)
      setError(null)
      if (command.type === 'story-copy') {
        const kept = session
          .snapshot()
          .document.outputs.filter(
            (output) => output.storyId === command.storyId && output.overrides[command.field]
          ).length
        setAnnouncement(
          `${storyOutputs.length - kept} formats updated; ${kept} keep custom ${command.field === 'headline' ? 'headlines' : 'supporting lines'}.`
        )
      } else setAnnouncement('Story Set updated. Undo is available.')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The change could not be applied.')
    }
  }
  async function attempt(action: () => Promise<void>) {
    try {
      flushActive()
      await action()
      setError(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The action failed.')
    }
  }
  const dimensions = outputDimensions(active)
  return (
    <main className="flex h-dvh min-h-[640px] flex-col bg-background">
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b px-4">
        <Link
          href="/creative-sets"
          aria-label="Back to Story Sets"
          onClick={(event) => {
            try {
              flushActive()
            } catch {
              event.preventDefault()
            }
          }}
          className="text-sm text-muted-foreground"
        >
          ← Sets
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-ui-lg font-semibold">{session.record.name}</h1>
        <SetCollaborators
          session={session}
          url={collabUrl}
          user={user}
          outputId={storeGroupId ?? activeId}
          revision={state.revision}
        />
        <span
          data-testid="set-save-status"
          role="status"
          className="text-xs text-muted-foreground"
          title={`Revision ${state.revision}`}
        >
          {state.status === 'saved'
            ? 'Saved'
            : state.status === 'offline'
              ? 'Offline · recovery draft'
              : state.status === 'conflict'
                ? 'Save conflict'
                : state.status === 'saving'
                  ? 'Saving…'
                  : state.status === 'error'
                    ? 'Save failed'
                    : 'Unsaved'}
        </span>
        {canEdit ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={!ready || !state.canUndo}
              onClick={() => {
                flushActive()
                session.undo()
              }}
            >
              Undo
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!ready || !state.canRedo}
              onClick={() => {
                flushActive()
                session.redo()
              }}
            >
              Redo
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            flushActive()
            setHistory(true)
          }}
        >
          History
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={canEdit && !ready}
          title="Copy every format onto a Canvas board; this set stays as it is."
          onClick={() =>
            void attempt(async () => {
              if (canEdit && !(await session.save()))
                throw new Error('Save the set before creating a Canvas copy.')
              router.push(`/canvas/new?set=${session.record.id}`)
            })
          }
        >
          Create Canvas copy
        </Button>
        {canEdit ? (
          <Button
            variant="outline"
            size="sm"
            disabled={!ready}
            onClick={() => {
              flushActive()
              setCampaignOpen(true)
            }}
          >
            Campaign…
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={canEdit && !ready}
          onClick={() =>
            void attempt(async () => {
              if (canEdit && !(await session.save()))
                throw new Error('Save the set before exporting.')
              setExporting(true)
            })
          }
        >
          Export
        </Button>
      </header>
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {error || state.error || state.recoveryError ? (
        <div className="border-b px-4 py-2 text-sm text-destructive" role="alert">
          {error ?? state.error ?? state.recoveryError}
          {state.status === 'offline' || state.status === 'error' ? (
            <Button variant="link" size="sm" onClick={() => void session.save()}>
              Retry save
            </Button>
          ) : null}
        </div>
      ) : null}
      {state.status === 'conflict' ? (
        <div className="flex items-center gap-3 border-b bg-amber-500/10 p-3" role="alert">
          <p className="flex-1 text-sm">
            This set changed elsewhere. Your local work is preserved.
          </p>
          <Button
            variant="outline"
            onClick={() =>
              void attempt(async () => {
                session.acceptSaved(
                  await session.client.creativeSet.get.query({ creativeSetId: session.record.id })
                )
              })
            }
          >
            Load saved version
          </Button>
          {canCreate ? (
            <Button
              onClick={() =>
                void attempt(async () => {
                  const copy = await session.preserveCopy()
                  router.push(`/creative-sets/${copy.id}`)
                })
              }
            >
              Keep mine as a copy
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          aria-label="Story"
          className="w-[280px] shrink-0 overflow-y-auto overflow-x-hidden border-r"
        >
          <div className="space-y-5 p-4">
            <nav aria-label="Stories" className="space-y-2">
              <p className="mb-3 text-xs font-medium text-muted-foreground">
                Stories · {state.document.stories.length}
              </p>
              {state.document.stories.map((item, index) => (
                <div key={item.id} className="flex items-center gap-1">
                  <Button
                    variant="custom"
                    size={null}
                    className={`min-w-0 flex-1 truncate rounded-md px-3 py-2.5 text-left text-sm ${item.id === story.id ? 'bg-foreground/[0.06] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.04]'}`}
                    aria-current={item.id === story.id ? 'true' : undefined}
                    onClick={() => {
                      flushActive()
                      const next = state.document.outputs.find(
                        (output) => output.storyId === item.id
                      )
                      if (next) {
                        setStoreGroupId(null)
                        setActiveId(next.id)
                      }
                    }}
                  >
                    {index + 1}. {item.headline}
                  </Button>
                  {canEdit && index > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Move story ${index + 1} earlier`}
                      onClick={() => {
                        const ids = state.document.stories.map((story) => story.id)
                        ;[ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!]
                        run({ type: 'reorder-stories', storyIds: ids })
                      }}
                    >
                      ↑
                    </Button>
                  ) : null}
                </div>
              ))}
              {canEdit ? (
                <div className="flex items-center justify-between gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!ready || state.document.stories.length >= 20}
                    onClick={() => {
                      flushActive()
                      setAddingStory(true)
                    }}
                  >
                    Add story
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" aria-label="Story actions">
                        <MoreHorizontalIcon className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={!ready || state.document.stories.length >= 20}
                        onSelect={() => {
                          flushActive()
                          setImportingProject(true)
                        }}
                      >
                        Copy project
                      </DropdownMenuItem>
                      {state.document.stories.length > 1 ? (
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={!ready}
                          onSelect={() => {
                            run({ type: 'remove-story', storyId: story.id })
                            setActiveId(session.snapshot().document.outputs[0]!.id)
                          }}
                        >
                          Remove story
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : null}
            </nav>
            <section aria-label="Store output groups" className="space-y-2">
              {state.document.storeGroups.map((group) => (
                <Button
                  className="w-full justify-start"
                  key={group.id}
                  size="sm"
                  variant={storeGroupId === group.id ? 'secondary' : 'ghost'}
                  onClick={() => {
                    flushActive()
                    setStoreGroupId(group.id)
                  }}
                >
                  {group.name} · {group.document.slides.length} slides
                </Button>
              ))}
              {canEdit ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!ready || state.document.storeGroups.length >= 20}
                  onClick={() => {
                    flushActive()
                    setImportingStore(true)
                  }}
                >
                  Add store outputs
                </Button>
              ) : null}
            </section>
            <Tabs defaultValue="message" className="gap-5 border-t pt-4">
              <TabsList
                aria-label="Story controls"
                className="grid w-full grid-cols-4 bg-transparent p-0"
              >
                {['Message', 'Product', 'Layout', 'Brand'].map((label) => (
                  <TabsTrigger
                    key={label}
                    value={label.toLowerCase()}
                    className="border-transparent px-1 text-xs data-[state=active]:border-foreground/20 data-[state=active]:bg-foreground/[0.06]"
                  >
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="message" className="space-y-5">
                <fieldset className="space-y-4" disabled={!canEdit || !ready}>
                  <legend className="mb-2 text-ui-lg font-medium">Shared message</legend>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Updates linked copy in every format. Custom wording stays yours.
                  </p>
                  {(['headline', 'supporting'] as ContentField[]).map((field) => (
                    <Label
                      key={`${story.id}:${field}:${story[field]}`}
                      className="grid gap-1.5 text-xs text-muted-foreground"
                    >
                      {field === 'headline' ? 'Story headline' : 'Story supporting line'}
                      <Textarea
                        aria-label={
                          field === 'headline' ? 'Story headline' : 'Story supporting line'
                        }
                        defaultValue={story[field]}
                        maxLength={300}
                        onBlur={(event) => {
                          if (event.target.value !== story[field])
                            run({
                              type: 'story-copy',
                              storyId: story.id,
                              field,
                              value: event.target.value,
                            })
                        }}
                        className="text-foreground"
                      />
                    </Label>
                  ))}
                </fieldset>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    flushActive()
                    setAiOpen(true)
                  }}
                >
                  Propose shorter copy…
                </Button>
              </TabsContent>
              <TabsContent value="product">
                <section className="space-y-4">
                  <h2 className="text-ui-lg font-medium">Product evidence</h2>
                  <p className="break-words text-xs text-muted-foreground">
                    {story.source.name} · revision {story.source.revision}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canEdit || !ready}
                    onClick={() => {
                      flushActive()
                      setSource(true)
                    }}
                  >
                    Replace story screenshot
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canEdit || !ready}
                    onClick={() => {
                      flushActive()
                      setFocusOpen(true)
                    }}
                  >
                    Edit focus region
                  </Button>
                </section>
              </TabsContent>
              <TabsContent value="layout">
                <section className="space-y-4">
                  <h2 className="text-ui-lg font-medium">Layout · this format</h2>
                  <Select
                    value={active.composition.id}
                    disabled={!canEdit || !ready || active.format === 'original'}
                    onValueChange={(value) =>
                      run({
                        type: 'layout',
                        outputId: active.id,
                        treatment: value as Treatment,
                      })
                    }
                  >
                    <SelectTrigger aria-label="This format layout" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {!treatmentSchema.safeParse(active.composition.id).success ? (
                        <SelectItem value={active.composition.id}>Imported composition</SelectItem>
                      ) : null}
                      {Object.entries(TREATMENTS).map(([id, label]) => (
                        <SelectItem key={id} value={id}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Choosing a treatment rearranges managed layers. Custom copy and added layers
                    stay.
                  </p>

                  <Label className="grid gap-1 text-xs">
                    Motion · this format
                    <Select
                      disabled={!canEdit || !ready}
                      value=""
                      onValueChange={(value) => {
                        flushActive()
                        session.commit(
                          applyStoryMotion(
                            session.snapshot().document,
                            activeId,
                            storyMotionSchema.parse(value)
                          )
                        )
                        useImageStore.setState({ showTimeline: true })
                      }}
                    >
                      <SelectTrigger aria-label="Motion · this format" className="w-full">
                        <SelectValue placeholder="Choose motion…" />
                      </SelectTrigger>
                      <SelectContent>
                        {storyMotionSchema.options.map((motion) => (
                          <SelectItem key={motion} value={motion}>
                            {STORY_MOTION[motion]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Label>
                  {active.document.timeline ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        flushActive()
                        setMotionExport(true)
                      }}
                    >
                      Deliver motion…
                    </Button>
                  ) : null}

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      flushActive()
                      setReusableOpen(true)
                    }}
                  >
                    Reusable treatments…
                  </Button>
                  <Button
                    size="sm"
                    variant="link"
                    disabled={!canEdit || !ready}
                    onClick={() => run({ type: 'reset-dimensions', outputId: active.id })}
                  >
                    Restore format dimensions
                  </Button>
                </section>
              </TabsContent>
              <TabsContent value="brand">
                <section className="space-y-4">
                  <h2 className="text-ui-lg font-medium">Brand · across this set</h2>
                  <p className="text-xs text-muted-foreground">
                    {state.document.brand
                      ? `${state.document.brand.name} · pinned v${state.document.brand.version}`
                      : 'Neutral bundled style'}
                  </p>
                  <Select
                    value=""
                    disabled={!canEdit || !ready}
                    onValueChange={(value) => {
                      flushActive()
                      const kit = kits.find((kit) => kit.id === value)
                      if (kit) {
                        const before = session.snapshot().document
                        void prepareSetBrand(session.client, before, kit)
                          .then((result) => setProposal({ ...result, before }))
                          .catch((error) => setError(error.message))
                      }
                    }}
                  >
                    <SelectTrigger aria-label="Preview workspace brand" className="w-full">
                      <SelectValue placeholder="Preview a brand kit…" />
                    </SelectTrigger>
                    <SelectContent>
                      {kits.map((kit) => (
                        <SelectItem key={kit.id} value={kit.id}>
                          {kit.name} · v{kit.version}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </section>
              </TabsContent>
            </Tabs>
            {canEdit ? (
              <Button
                className="w-full border-t"
                variant="ghost"
                size="sm"
                onClick={() => setAdvanced(!advanced)}
              >
                {advanced ? 'Hide advanced tools' : 'Advanced editing tools'}
              </Button>
            ) : null}
          </div>
          {advanced ? <ComposePanel /> : null}
        </aside>
        {storeGroup ? (
          <StoreGroupEditor
            key={`${storeGroup.id}:${state.loadEpoch}`}
            session={session}
            group={storeGroup}
            canEdit={canEdit}
            registerFlush={registerStoreFlush}
          />
        ) : (
          <section
            aria-label="Active output"
            className="flex min-w-0 flex-1 flex-col bg-foreground/[0.035]"
          >
            <div className="flex items-center justify-between px-6 py-3">
              <h2 className="text-ui-lg font-medium">
                {dimensions.name}{' '}
                <span className="ml-2 text-xs text-muted-foreground">
                  {dimensions.width} × {dimensions.height}
                </span>
              </h2>
              <span className="text-xs text-muted-foreground">
                {active.document.texts.find((text) => text.id === active.bindings.headline)
                  ?.visible === false
                  ? 'Screenshot-led · copy optional'
                  : active.overrides.headline
                    ? 'Custom headline'
                    : 'Headline linked to Story'}
              </span>
            </div>
            {active.review.source || active.review.redactions || active.review.wording ? (
              <div className="mx-5 flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="flex-1 text-xs">
                  {active.review.source ? 'Check the new screenshot, focus and crop. ' : ''}
                  {active.review.redactions ? 'Recheck every redaction before delivery. ' : ''}
                  {active.review.wording ? 'The story changed. Check your custom wording. ' : ''}
                </p>
                {canEdit ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!ready}
                    onClick={() => run({ type: 'reviewed', outputId: active.id })}
                  >
                    Mark format reviewed
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div
              data-canvas-viewport
              className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6"
            >
              {canEdit ? (
                <CanvasStageShell id="image-render-card" className="overflow-hidden">
                  <ClientCanvas embedded />
                </CanvasStageShell>
              ) : (
                <ProjectPreview alt={dimensions.name} document={active.document} />
              )}
              {canEdit && !ready ? (
                <div className="absolute inset-0 z-40 grid place-items-center bg-background/70 text-sm">
                  {error ? 'Canvas unavailable' : 'Loading format…'}
                </div>
              ) : null}
            </div>
            {canEdit ? <TimelineEditor /> : null}
            <div
              className="flex shrink-0 justify-center gap-3 overflow-x-auto border-t bg-background px-4 py-3"
              aria-label="Formats"
            >
              {storyOutputs.map((output) => (
                <Button
                  variant="custom"
                  size={null}
                  key={output.id}
                  aria-pressed={active.id === output.id}
                  onClick={() => {
                    flushActive()
                    setActiveId(output.id)
                  }}
                  className={`w-40 shrink-0 rounded-lg border p-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring ${active.id === output.id ? 'border-emerald-500/70 bg-emerald-500/[0.04]' : 'border-transparent hover:bg-foreground/[0.04]'}`}
                >
                  <div className="h-20">
                    <ProjectPreview
                      alt={outputDimensions(output).name}
                      document={output.document}
                    />
                  </div>
                  <p className="mt-2 text-xs font-medium">{outputDimensions(output).name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {output.review.source || output.review.redactions || output.review.wording
                      ? 'Review needed'
                      : output.document.texts.find((text) => text.id === output.bindings.headline)
                            ?.visible === false
                        ? 'Screenshot-led'
                        : output.overrides.headline
                          ? 'Custom copy'
                          : 'Linked copy'}
                  </p>
                </Button>
              ))}
            </div>
          </section>
        )}
        {canEdit && !storeGroup ? (
          <aside aria-label="This format" className="w-[272px] shrink-0 overflow-y-auto border-l">
            <Tabs defaultValue="copy" className="gap-4 pt-4">
              <div className="px-4">
                <h2 className="mb-3 text-ui-lg font-medium">This format</h2>
                <TabsList aria-label="Format controls" className="w-full">
                  <TabsTrigger
                    value="copy"
                    className="border-transparent data-[state=active]:border-foreground/20"
                  >
                    Copy
                  </TabsTrigger>
                  <TabsTrigger
                    value="design"
                    className="border-transparent data-[state=active]:border-foreground/20"
                  >
                    Design
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="copy" className="space-y-6 px-4 pb-5">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Tailor the wording for this format. The other formats keep their copy.
                </p>
                {(['source', 'focus'] as const)
                  .filter((field) => active.overrides[field])
                  .map((field) => (
                    <div key={field} className="text-xs text-muted-foreground">
                      {field === 'source' ? 'Product screen' : 'Focus detail'} ·{' '}
                      {active.overrides[field] ? 'Override, this format' : 'Linked to story'}
                      {active.overrides[field] ? (
                        <Button
                          size="sm"
                          variant="link"
                          disabled={!ready}
                          onClick={() =>
                            run({ type: 'reset-evidence', outputId: active.id, field })
                          }
                        >
                          Reset {field} to story
                        </Button>
                      ) : null}
                    </div>
                  ))}
                {(['headline', 'supporting'] as ContentField[]).map((field) => {
                  const layer = active.document.texts.find(
                    (text) => text.id === active.bindings[field]
                  )
                  const value = layer?.visible === false ? '' : (layer?.text ?? '')
                  return (
                    <div key={`${active.id}:${field}:${value}`} className="space-y-2">
                      <Label className="grid gap-1.5 text-xs">
                        {field === 'headline'
                          ? 'This format headline'
                          : 'This format supporting line'}
                        <Textarea
                          aria-label={
                            field === 'headline'
                              ? 'This format headline'
                              : 'This format supporting line'
                          }
                          defaultValue={value}
                          maxLength={300}
                          disabled={!ready}
                          onFocus={() =>
                            useImageStore.getState().setSelectedTextId(active.bindings[field])
                          }
                          onBlur={(event) => {
                            if (event.target.value !== value)
                              run({
                                type: 'output-copy',
                                outputId: active.id,
                                field,
                                value: event.target.value,
                              })
                          }}
                        />
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {layer?.visible === false
                          ? 'Not shown on this format'
                          : active.overrides[field]
                            ? 'Override · this format only'
                            : `Linked to Story ${field}`}
                      </p>
                      {active.overrides[field] ? (
                        <div className="flex flex-wrap gap-1">
                          <Button
                            variant="link"
                            size="sm"
                            disabled={!ready}
                            onClick={() => run({ type: 'reset-copy', outputId: active.id, field })}
                          >
                            Reset {field} to story
                          </Button>
                          <Button
                            variant="link"
                            size="sm"
                            disabled={!ready || !value.trim()}
                            onClick={() =>
                              run({ type: 'promote-copy', outputId: active.id, field })
                            }
                          >
                            Use across this story
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </TabsContent>
              <TabsContent value="design">
                {selectedTextId
                  ? localTextBrandFields(active, selectedTextId).map((field) => (
                      <div className="text-xs" key={field}>
                        {TEXT_BRAND_FIELDS[field]} · Override
                        <Button
                          size="sm"
                          variant="link"
                          disabled={!ready}
                          onClick={() =>
                            void attempt(async () => {
                              const { brandKits } = await session.client.brandKit.list.query()
                              const stored = brandKits.find(
                                (kit) => kit.id === session.snapshot().document.brand?.id
                              )
                              const kit = stored ? readBrandKit(stored) : null
                              if (!kit) throw new Error('The pinned brand version is unavailable.')
                              session.commit(
                                resetTextBrandField(
                                  session.snapshot().document,
                                  active.id,
                                  selectedTextId,
                                  field,
                                  kit
                                )
                              )
                            })
                          }
                        >
                          Reset {TEXT_BRAND_FIELDS[field].toLowerCase()} to brand
                        </Button>
                      </div>
                    ))
                  : null}
                <InspectorPanel />
              </TabsContent>
            </Tabs>
          </aside>
        ) : null}
      </div>
      {importingStore ? (
        <ImportStoreProject
          session={session}
          onClose={() => setImportingStore(false)}
          onAdded={setStoreGroupId}
        />
      ) : null}
      {reusableOpen ? (
        <ReusableDialog
          session={session}
          outputId={activeId}
          onClose={() => setReusableOpen(false)}
        />
      ) : null}
      {aiOpen ? (
        <ProposalDialog session={session} outputId={activeId} onClose={() => setAiOpen(false)} />
      ) : null}
      {motionExport ? (
        <MotionDeliveryDialog
          session={session}
          outputId={activeId}
          onClose={() => setMotionExport(false)}
        />
      ) : null}
      {campaignOpen ? (
        <CampaignHandoffDialog session={session} onClose={() => setCampaignOpen(false)} />
      ) : null}
      {history ? (
        <SetVersionHistory session={session} canEdit={canEdit} onClose={() => setHistory(false)} />
      ) : null}
      {focusOpen ? (
        <EditStoryFocus session={session} storyId={story.id} onClose={() => setFocusOpen(false)} />
      ) : null}
      {source ? (
        <SourceUpdate session={session} storyId={story.id} onClose={() => setSource(false)} />
      ) : null}
      {addingStory ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setAddingStory(false)
          }}
        >
          <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-6xl">
            <DialogTitle>Add a product story</DialogTitle>
            <DialogDescription>
              Each benefit has its own evidence and linked formats.
            </DialogDescription>
            <StorySetIntake
              onCancel={() => setAddingStory(false)}
              onAdd={(document) => {
                const added = document.stories[0]!
                run({
                  type: 'add-story',
                  story: added,
                  treatment: treatmentSchema.parse(document.outputs[0]!.composition.id),
                })
                setActiveId(
                  session.snapshot().document.outputs.find((output) => output.storyId === added.id)!
                    .id
                )
                setAddingStory(false)
              }}
            />
          </DialogContent>
        </Dialog>
      ) : null}
      {importingProject ? (
        <ImportProject
          onClose={() => setImportingProject(false)}
          onImport={(document) => {
            const imported = document.stories[0]!
            run({ type: 'import-story', story: imported, outputs: document.outputs })
            setActiveId(document.outputs[0]!.id)
          }}
        />
      ) : null}
      {exporting ? (
        <StorySetExport
          session={session}
          canSave={canEdit}
          onClose={() => setExporting(false)}
          onFix={(id) => {
            setStoreGroupId(null)
            setActiveId(id)
          }}
        />
      ) : null}
      {proposal ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setProposal(null)
          }}
        >
          <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-5xl">
            <DialogTitle>Review brand update</DialogTitle>
            <DialogDescription>
              {proposal.keptOverrides} local style overrides will be preserved. This pins the
              selected brand version.
            </DialogDescription>
            <ChangeComparison before={proposal.before} after={proposal.document} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setProposal(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (
                    JSON.stringify(session.snapshot().document) !== JSON.stringify(proposal.before)
                  ) {
                    setError('The set changed. Preview the brand update again.')
                    setProposal(null)
                    return
                  }
                  session.commit(proposal.document)
                  setProposal(null)
                }}
              >
                Apply brand update
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </main>
  )
}
