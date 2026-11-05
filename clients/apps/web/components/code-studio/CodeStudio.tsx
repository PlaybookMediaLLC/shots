'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/ssr/ArrowLeft'
import { ArrowUUpLeftIcon } from '@phosphor-icons/react/dist/ssr/ArrowUUpLeft'
import { ArrowUUpRightIcon } from '@phosphor-icons/react/dist/ssr/ArrowUUpRight'
import { CaretLeftIcon } from '@phosphor-icons/react/dist/ssr/CaretLeft'
import { CaretRightIcon } from '@phosphor-icons/react/dist/ssr/CaretRight'
import { CopySimpleIcon } from '@phosphor-icons/react/dist/ssr/CopySimple'
import { DownloadSimpleIcon } from '@phosphor-icons/react/dist/ssr/DownloadSimple'
import { FloppyDiskIcon } from '@phosphor-icons/react/dist/ssr/FloppyDisk'
import { GithubLogoIcon } from '@phosphor-icons/react/dist/ssr/GithubLogo'
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/ssr/PaperPlaneTilt'
import { PlusIcon } from '@phosphor-icons/react/dist/ssr/Plus'
import { TrashIcon } from '@phosphor-icons/react/dist/ssr/Trash'
import { VideoCameraIcon } from '@phosphor-icons/react/dist/ssr/VideoCamera'
import { toast } from 'sonner'
import { decodeHashState } from '@/components/code-image/EditorShell'
import { GOOGLE_FONTS_URL, type CodeImageState } from '@/components/code-image/code-themes'
import { usePrivateCreativeSurface } from '@/components/creative-sets/use-private-surface'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { trackEvent } from '@/lib/analytics'
import { loadBrandKits, useBrandKits } from '@/lib/brand/library'
import {
  codeDocumentFromLegacy,
  codeDocumentSchema,
  newCodeDocument,
  readCodeDocument,
  type CodeDocument,
  type LineRange,
} from '@/lib/code-studio/document'
import {
  duplicateSlide,
  moveSlide,
  removeSlide,
  selectFile,
  updateFile,
} from '@/lib/code-studio/edit'
import { documentSize, slideSize } from '@/lib/code-studio/layout'
import { CodeSession, readCodeRecoveries, type CodeSessionState } from '@/lib/code-studio/session'
import { newCreativeSetId } from '@/lib/creative-sets/document'
import { removeSetRecovery } from '@/lib/creative-sets/recovery'
import { assetContentUrl } from '@/lib/editor/services'
import { writePdf, pdfImageFromBlob, type PdfPage } from '@/lib/export/pdf'
import { zipFiles } from '@/lib/export/zip'
import { registerNavigationGuard } from '@/lib/platform/navigation-guard'
import { useTRPCClient } from '@/lib/trpc/react'
import { saveExportToWorkspace } from '@/lib/workspace/save-export'
import { useSceneCapture } from './capture'
import { CodeInspector } from './CodeInspector'
import { CodeScene, type SceneEditing } from './CodeScene'
import { ImportCodeDialog } from './ImportCodeDialog'
import { PostThisDialog } from './PostThisDialog'
import { ShareEmbedDialog } from './ShareEmbedDialog'
import { SlideSettings } from './SlideSettings'
import { VideoExportDialog, useVideoRenderer } from './VideoExportDialog'

const DRAFT_KEY = 'shots.code-studio.draft.v1'
const FONTS_LINK_ID = 'code-image-google-fonts'
const COMMIT_DELAY = 400

/** This browser's unsaved project, kept until it is saved to the workspace. */
function readDraft(): CodeDocument | null {
  try {
    return readCodeDocument(JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? 'null'))
  } catch {
    return null
  }
}

function writeDraft(document: CodeDocument | null) {
  try {
    if (document) window.localStorage.setItem(DRAFT_KEY, JSON.stringify(document))
    else window.localStorage.removeItem(DRAFT_KEY)
  } catch {
    // Private windows can refuse storage; the draft then lives only in this tab.
  }
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = window.document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

const fileStem = (name: string) =>
  name
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'code'

const STATUS_TEXT: Record<CodeSessionState['status'], string> = {
  saved: 'Saved to workspace',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  offline: 'Offline · kept on this device',
  conflict: 'Edited elsewhere',
  error: 'Not saved',
}

/** Props of {@link CodeStudio}. */
export type CodeStudioProps = {
  /** The saved project to open; absent for a new one that stays in this browser until saved. */
  projectId?: string
  workspaceId: string
  canEdit: boolean
  canStartPost: boolean
}

/**
 * Code Studio (RFC 053): turn code into images, carousels and videos, then
 * post them. A new project stays in this browser until the person saves it;
 * a saved one autosaves through the creative-set revision path.
 */
export function CodeStudio({ projectId, workspaceId, canEdit, canStartPost }: CodeStudioProps) {
  usePrivateCreativeSurface()
  const client = useTRPCClient()
  const [session, setSession] = React.useState<CodeSession | null>(null)
  const [draft, setDraft] = React.useState<CodeDocument | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [recovery, setRecovery] = React.useState<
    Awaited<ReturnType<typeof readCodeRecoveries>>[number] | null
  >(null)

  React.useEffect(() => {
    if (!window.document.getElementById(FONTS_LINK_ID)) {
      const link = window.document.createElement('link')
      link.id = FONTS_LINK_ID
      link.rel = 'stylesheet'
      link.href = GOOGLE_FONTS_URL
      window.document.head.appendChild(link)
    }
  }, [])

  React.useEffect(() => {
    if (projectId) return
    // An old /code link carries its snippet in the hash; it wins over this browser's draft.
    const hash = window.location.hash.slice(1)
    const legacy = hash ? decodeHashState<CodeImageState>(hash) : null
    if (legacy) window.history.replaceState(null, '', window.location.pathname)
    setDraft(legacy ? codeDocumentFromLegacy(legacy) : (readDraft() ?? newCodeDocument()))
  }, [projectId])

  React.useEffect(() => {
    if (!projectId) return
    let active = true
    let instance: CodeSession | null = null
    void (async () => {
      const record = await client.codeProject.get.query({ projectId })
      if (!active) return
      instance = new CodeSession(record, client)
      setSession(instance)
      if (!canEdit) return
      try {
        const drafts = await readCodeRecoveries(workspaceId, projectId)
        const found = drafts.find(
          (item) => JSON.stringify(item.document) !== JSON.stringify(record.document)
        )
        if (active && found) setRecovery(found)
      } catch {
        if (active)
          setError('Local recovery is unavailable on this device. Cloud saving still works.')
      }
    })().catch((failure: unknown) => {
      if (active)
        setError(
          failure instanceof Error
            ? failure.message
            : 'This code project could not be opened. Update the app if a newer version saved it.'
        )
    })
    return () => {
      active = false
      instance?.dispose()
    }
  }, [client, projectId, workspaceId, canEdit])

  if (error && !session && projectId)
    return (
      <main className="grid min-h-[60vh] place-items-center p-8">
        <div className="max-w-md space-y-3 text-center">
          <h1 className="text-lg font-semibold">This code project could not be opened</h1>
          <p role="alert" className="text-sm text-muted-foreground">
            {error}
          </p>
          <Button variant="outline" asChild>
            <Link href="/library?type=code">Back to Library</Link>
          </Button>
        </div>
      </main>
    )
  if (projectId ? !session : !draft)
    return (
      <main className="grid h-full place-items-center" aria-busy>
        <p className="text-sm text-muted-foreground">Opening Code Studio…</p>
      </main>
    )
  return (
    <>
      {session ? (
        <SavedWorkspace
          session={session}
          canEdit={canEdit}
          canStartPost={canStartPost}
          notice={error}
        />
      ) : (
        <DraftWorkspace initial={draft!} canEdit={canEdit} canStartPost={canStartPost} />
      )}
      {recovery && session ? (
        <Dialog open>
          <DialogContent showCloseButton={false}>
            <DialogTitle>Recover unsaved work</DialogTitle>
            <DialogDescription>
              This device kept a draft from {new Date(recovery.updatedAt).toLocaleString()} that was
              not saved. It is based on revision {recovery.revision}; the saved project is at
              revision {session.snapshot().revision}.
            </DialogDescription>
            <div className="flex justify-end gap-2">
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

/** A new project in this browser: nothing reaches the server until Save. */
function DraftWorkspace({
  initial,
  canEdit,
  canStartPost,
}: {
  initial: CodeDocument
  canEdit: boolean
  canStartPost: boolean
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [document, setDocument] = React.useState(initial)
  const [name, setName] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  React.useEffect(() => {
    const timer = setTimeout(() => writeDraft(document), COMMIT_DELAY)
    return () => clearTimeout(timer)
  }, [document])
  const save = async () => {
    setSaving(true)
    try {
      const id = newCreativeSetId()
      const first = document.slides[0]!.panes[0]!.files[0]!
      await client.codeProject.create.mutate({
        id,
        document: codeDocumentSchema.parse(document),
        name: name.trim() || first.name || 'Untitled code',
      })
      writeDraft(null)
      trackEvent('code_studio_save', { slides: document.slides.length })
      // A campaign handoff continues on the saved project.
      const campaign = new URLSearchParams(window.location.search).get('campaign')
      router.replace(`/create/code/${id}${campaign ? `?${new URLSearchParams({ campaign })}` : ''}`)
    } catch (failure) {
      toast.error('Could not save the project', {
        description:
          failure instanceof Error ? failure.message : 'Your code is still in this browser.',
      })
      setSaving(false)
    }
  }
  return (
    <Workspace
      document={document}
      onChange={setDocument}
      name={name}
      onRename={setName}
      status={
        canEdit ? (
          <Button size="sm" variant="outline" onClick={save} disabled={saving}>
            <FloppyDiskIcon /> {saving ? 'Saving…' : 'Save to workspace'}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">In this browser only</span>
        )
      }
      hint="Your code stays in this browser until you save it."
      canEdit={canEdit}
      canStartPost={canStartPost}
    />
  )
}

/** An open saved project: edits commit to the session, which autosaves and merges. */
function SavedWorkspace({
  session,
  canEdit,
  canStartPost,
  notice,
}: {
  session: CodeSession
  canEdit: boolean
  canStartPost: boolean
  notice: string | null
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const state = React.useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot)
  const [document, setDocument] = React.useState(state.document)
  const [name, setName] = React.useState(session.record.name)
  const savedName = React.useRef(session.record.name)
  const pending = React.useRef<CodeDocument | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const flush = React.useCallback(() => {
    clearTimeout(timer.current)
    if (pending.current) session.commit(pending.current)
    pending.current = null
  }, [session])
  // Undo, a recovered draft or a merged save replaces what the editor shows.
  React.useEffect(() => {
    if (!pending.current) setDocument(session.snapshot().document)
  }, [session, state.loadEpoch, state.revision])
  const change = (next: CodeDocument) => {
    setDocument(next)
    pending.current = next
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, COMMIT_DELAY)
  }
  const save = React.useCallback(async () => {
    flush()
    return session.save()
  }, [flush, session])
  React.useEffect(
    () =>
      registerNavigationGuard(async () => {
        if (canEdit && !(await save())) throw new Error('Save the code project before leaving.')
      }, true),
    [save, canEdit]
  )
  React.useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      flush()
      if (canEdit && session.snapshot().status !== 'saved') event.preventDefault()
    }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [flush, session, canEdit])
  const rename = async () => {
    const next = name.trim()
    if (!next || next === savedName.current) return setName(savedName.current)
    try {
      await client.codeProject.rename.mutate({ projectId: session.record.id, name: next })
      savedName.current = next
    } catch (failure) {
      setName(savedName.current)
      toast.error(failure instanceof Error ? failure.message : 'The project was not renamed.')
    }
  }
  return (
    <Workspace
      document={document}
      onChange={canEdit ? change : () => undefined}
      name={name}
      onRename={setName}
      onRenameDone={rename}
      flush={canEdit ? save : undefined}
      projectId={session.record.id}
      status={
        <span className="flex items-center gap-1">
          {canEdit ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Undo"
                disabled={!state.canUndo}
                onClick={() => {
                  flush()
                  session.undo()
                }}
              >
                <ArrowUUpLeftIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Redo"
                disabled={!state.canRedo}
                onClick={() => session.redo()}
              >
                <ArrowUUpRightIcon />
              </Button>
            </>
          ) : null}
          <span
            data-testid="code-save-status"
            role="status"
            className="text-xs whitespace-nowrap text-muted-foreground"
          >
            {canEdit ? STATUS_TEXT[state.status] : 'View only'}
          </span>
        </span>
      }
      banner={
        state.status === 'conflict' ? (
          <div className="flex flex-wrap items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-sm">
            <span className="flex-1">{state.error ?? 'Someone else saved this project.'}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const copy = await session.preserveCopy()
                router.push(`/create/code/${copy.id}`)
              }}
            >
              Keep mine as a copy
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                pending.current = null
                session.acceptSaved(
                  await client.codeProject.get.query({ projectId: session.record.id })
                )
              }}
            >
              Load the saved version
            </Button>
          </div>
        ) : notice || state.recoveryError ? (
          <p role="status" className="border-b px-4 py-2 text-xs text-muted-foreground">
            {notice ?? state.recoveryError}
          </p>
        ) : null
      }
      canEdit={canEdit}
      canStartPost={canStartPost}
    />
  )
}

type WorkspaceProps = {
  document: CodeDocument
  onChange: (document: CodeDocument) => void
  name: string
  onRename: (name: string) => void
  onRenameDone?: () => void
  flush?: () => Promise<boolean>
  projectId?: string
  status: React.ReactNode
  banner?: React.ReactNode
  hint?: string
  canEdit: boolean
  canStartPost: boolean
}

/** The studio itself: toolbar, stage, slide strip and inspector. */
function Workspace({
  document,
  onChange,
  name,
  onRename,
  onRenameDone,
  flush,
  projectId,
  status,
  banner,
  hint,
  canEdit,
  canStartPost,
}: WorkspaceProps) {
  const client = useTRPCClient()
  const kits = useBrandKits((state) => state.kits)
  const [slideIndex, setSlideIndex] = React.useState(0)
  const slide = document.slides[Math.min(slideIndex, document.slides.length - 1)]!
  const current = document.slides.indexOf(slide)
  const [paneId, setPaneId] = React.useState(slide.panes[0]!.id)
  const pane = slide.panes.find((item) => item.id === paneId) ?? slide.panes[0]!
  const [selection, setSelection] = React.useState<NonNullable<SceneEditing['selection']> | null>(
    null
  )
  const anchor = React.useRef<number | null>(null)
  const [posting, setPosting] = React.useState(false)
  const [importing, setImporting] = React.useState(false)
  const [video, setVideo] = React.useState(false)
  const [embedding, setEmbedding] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const capture = useSceneCapture()
  const params = useSearchParams()
  const campaignId = /^c[a-z0-9]{8,40}$/.test(params.get('campaign') ?? '')
    ? params.get('campaign')
    : null
  const importUrl = params.get('import')
  React.useEffect(() => {
    // A Code highlights link prefills the import; nothing is read until the member imports it.
    if (importUrl && canEdit) setImporting(true)
  }, [importUrl, canEdit])
  const logo = document.style.footer.logo
  const logoUrl = logo ? assetContentUrl(logo.slice('asset:'.length)) : undefined
  const renderVideo = useVideoRenderer(document, capture, logoUrl)

  React.useEffect(() => {
    if (canEdit) void loadBrandKits(client).catch(() => undefined)
  }, [client, canEdit])

  const editing: SceneEditing | undefined = canEdit
    ? {
        paneId: pane.id,
        selection,
        onCodeChange: (paneId, fileId, code) =>
          onChange(updateFile(document, { slide: current, pane: paneId, file: fileId }, { code })),
        onSelectTab: (paneId, fileId) => {
          setPaneId(paneId)
          onChange(selectFile(document, current, paneId, fileId))
        },
        onLineClick: (paneId, fileId, line, extend) => {
          setPaneId(paneId)
          const start = extend && anchor.current !== null ? anchor.current : line
          if (!extend) anchor.current = line
          const range: LineRange = [Math.min(start, line), Math.max(start, line)]
          setSelection(
            selection?.fileId === fileId &&
              !extend &&
              selection.range[0] === line &&
              selection.range[1] === line
              ? null
              : { paneId, fileId, range }
          )
        },
      }
    : undefined

  const frame = (index: number) => ({
    document,
    slideIndex: index,
    size: documentSize(document),
    logoUrl,
  })
  const renderSlide = (index: number, scale = 2) =>
    capture.png({ ...frame(index), size: slideSize(document, index) }, scale).finally(capture.done)

  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(true)
    try {
      await task()
      trackEvent('code_studio_export', { kind: label, slides: document.slides.length })
    } catch (failure) {
      toast.error('The export failed', {
        description: failure instanceof Error ? failure.message : 'Try again.',
      })
    } finally {
      capture.done()
      setBusy(false)
    }
  }
  const stem = fileStem(name || pane.files[0]!.name)
  const carousel = async () => {
    const blobs: Blob[] = []
    for (const index of document.slides.keys()) blobs.push(await capture.png(frame(index), 2))
    return blobs
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-code-studio>
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon" asChild aria-label="Back to Library">
          <Link href="/library?type=code">
            <ArrowLeftIcon />
          </Link>
        </Button>
        <Input
          aria-label="Project name"
          className="h-8 w-56 max-w-[40vw]"
          placeholder="Untitled code"
          maxLength={200}
          value={name}
          disabled={!canEdit}
          onChange={(event) => onRename(event.target.value)}
          onBlur={onRenameDone}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        />
        {status}
        <div className="ms-auto flex items-center gap-2">
          {canEdit ? (
            <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>
              <GithubLogoIcon /> Import
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={busy}>
                <DownloadSimpleIcon /> {busy ? 'Exporting…' : 'Export'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>This slide</DropdownMenuLabel>
              {[2, 4].map((scale) => (
                <DropdownMenuItem
                  key={scale}
                  onSelect={() =>
                    run(`png-${scale}x`, async () =>
                      download(await renderSlide(current, scale), `${stem}.png`)
                    )
                  }
                >
                  Download PNG at {scale}x
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem
                onSelect={() =>
                  run('copy', async () => {
                    const blob = await renderSlide(current)
                    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
                    toast.success('Image copied')
                  })
                }
              >
                <CopySimpleIcon /> Copy image
              </DropdownMenuItem>
              {canEdit ? (
                <DropdownMenuItem
                  onSelect={() =>
                    run('library', async () => {
                      await saveExportToWorkspace({
                        blob: await renderSlide(current),
                        fileName: `${stem}.png`,
                        classification: 'export',
                        trpcClient: client,
                      })
                      toast.success('Saved to Library', {
                        description: 'The image is in Library › Assets for your team.',
                      })
                    })
                  }
                >
                  Save image to Library
                </DropdownMenuItem>
              ) : null}
              {campaignId && canEdit ? (
                <DropdownMenuItem
                  onSelect={() =>
                    run('campaign', async () => {
                      const { assetId } = await saveExportToWorkspace({
                        blob: await renderSlide(current),
                        fileName: `${stem}.png`,
                        classification: 'export',
                        trpcClient: client,
                      })
                      await client.codeProject.addToCampaign.mutate({
                        assetId,
                        campaignId,
                        caption: slide.caption || name || undefined,
                      })
                      toast.success('Added to the campaign', {
                        action: {
                          label: 'View visuals',
                          onClick: () => window.location.assign(`/campaigns/${campaignId}/assets`),
                        },
                      })
                    })
                  }
                >
                  Add image to campaign
                </DropdownMenuItem>
              ) : null}
              {document.slides.length > 1 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Carousel · {document.slides.length} slides</DropdownMenuLabel>
                  <DropdownMenuItem
                    onSelect={() =>
                      run('zip', async () => {
                        const blobs = await carousel()
                        download(
                          await zipFiles(
                            blobs.map((data, index) => ({ data, path: `${stem}-${index + 1}.png` }))
                          ),
                          `${stem}.zip`
                        )
                      })
                    }
                  >
                    Download PNGs (ZIP)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      run('pdf', async () => {
                        const size = documentSize(document)
                        const pages: PdfPage[] = []
                        for (const blob of await carousel())
                          pages.push({ ...size, image: await pdfImageFromBlob(blob, 'jpeg', 0.92) })
                        download(
                          new Blob([writePdf(pages, { title: name || 'Code' })], {
                            type: 'application/pdf',
                          }),
                          `${stem}.pdf`
                        )
                      })
                    }
                  >
                    Download PDF (LinkedIn carousel)
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setVideo(true)}>
                <VideoCameraIcon /> Export video…
              </DropdownMenuItem>
              {canEdit ? (
                <DropdownMenuItem onSelect={() => setEmbedding(true)}>
                  Embed code on a site…
                </DropdownMenuItem>
              ) : null}
              {projectId ? (
                <DropdownMenuItem
                  onSelect={() =>
                    void navigator.clipboard.writeText(window.location.href).then(
                      () => toast.success('Link copied. Only workspace members can open it.'),
                      () => toast.error('Could not copy the link')
                    )
                  }
                >
                  Copy link
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          {canStartPost ? (
            <Button size="sm" onClick={() => setPosting(true)}>
              <PaperPlaneTiltIcon /> Post this
            </Button>
          ) : null}
        </div>
      </header>
      {banner}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Stage document={document} slideIndex={current} editing={editing} logoUrl={logoUrl} />
          <SlideStrip
            document={document}
            current={current}
            canEdit={canEdit}
            onSelect={(index) => {
              setSlideIndex(index)
              setSelection(null)
              // Add slide selects a slide this render's document does not have
              // yet; an unknown pane falls back to the slide's first pane.
              setPaneId(document.slides[index]?.panes[0]?.id ?? '')
            }}
            onChange={onChange}
          />
          {hint ? (
            <p className="border-t px-4 py-1.5 text-xs text-muted-foreground">{hint}</p>
          ) : null}
        </div>
        <aside
          className="w-80 shrink-0 overflow-y-auto border-l max-md:hidden"
          aria-label="Code Studio settings"
        >
          <CodeInspector
            document={document}
            slideIndex={current}
            paneId={pane.id}
            selection={selection}
            brandKits={kits}
            disabled={!canEdit}
            onChange={onChange}
            onPane={setPaneId}
          />
          <SlideSettings
            document={document}
            slideIndex={current}
            disabled={!canEdit}
            onChange={onChange}
          />
        </aside>
      </div>
      {capture.host}
      {canStartPost ? (
        <PostThisDialog
          open={posting}
          onOpenChange={setPosting}
          document={document}
          slideIndex={current}
          flush={flush}
          renderSlide={(index) => renderSlide(index)}
          renderVideo={renderVideo.supported ? renderVideo.mp4 : undefined}
          writeCaption={async () =>
            (
              await client.codeProject.caption.mutate({
                document: codeDocumentSchema.parse(document),
                slide: current,
              })
            ).caption
          }
        />
      ) : null}
      <ImportCodeDialog
        initialUrl={importUrl ?? ''}
        open={importing}
        onOpenChange={setImporting}
        document={document}
        slideIndex={current}
        onImport={(next, slide) => {
          onChange(next)
          setSlideIndex(slide)
          setPaneId(next.slides[slide]!.panes[0]!.id)
        }}
      />
      {canEdit ? (
        <ShareEmbedDialog
          open={embedding}
          onOpenChange={setEmbedding}
          document={document}
          slideIndex={current}
          name={name}
          renderSlide={(index) => renderSlide(index)}
        />
      ) : null}
      <VideoExportDialog
        open={video}
        onOpenChange={setVideo}
        document={document}
        name={stem}
        renderer={renderVideo}
      />
    </div>
  )
}

/** The scene, scaled to fit, with a checkerboard where the background is transparent. */
function Stage({
  document,
  slideIndex,
  editing,
  logoUrl,
}: {
  document: CodeDocument
  slideIndex: number
  editing?: SceneEditing
  logoUrl?: string
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [box, setBox] = React.useState({ width: 0, height: 0 })
  React.useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) =>
      setBox({ width: entry!.contentRect.width, height: entry!.contentRect.height })
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const size = slideSize(document, slideIndex)
  const scale = box.width
    ? Math.min(1, (box.width - 48) / size.width, (box.height - 48) / size.height)
    : 1
  return (
    <div
      ref={ref}
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/40"
    >
      <div
        style={{
          width: size.width * scale,
          height: size.height * scale,
          backgroundImage: document.style.showBackground
            ? undefined
            : 'repeating-conic-gradient(rgba(127,127,127,0.18) 0% 25%, transparent 0% 50%)',
          backgroundSize: '20px 20px',
        }}
      >
        <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          <CodeScene
            document={document}
            slideIndex={slideIndex}
            editing={editing}
            logoUrl={logoUrl}
          />
        </div>
      </div>
    </div>
  )
}

/** Slides: the pages of a carousel and the steps of a video. */
function SlideStrip({
  document,
  current,
  canEdit,
  onSelect,
  onChange,
}: {
  document: CodeDocument
  current: number
  canEdit: boolean
  onSelect: (index: number) => void
  onChange: (document: CodeDocument) => void
}) {
  return (
    <nav aria-label="Slides" className="flex items-center gap-2 overflow-x-auto border-t px-3 py-2">
      {document.slides.map((slide, index) => {
        const first = slide.panes[0]!.files.find((file) => file.id === slide.panes[0]!.activeFile)
        const preview =
          (first?.tape ?? first?.code ?? '').split('\n').find((line) => line.trim()) ?? ''
        return (
          <Button
            key={slide.id}
            variant={index === current ? 'secondary' : 'ghost'}
            size="sm"
            aria-current={index === current ? 'step' : undefined}
            className="max-w-44 shrink-0 justify-start font-mono text-xs"
            onClick={() => onSelect(index)}
          >
            <span className="font-sans font-semibold tabular-nums">{index + 1}</span>
            <span className="truncate">{preview || 'Empty'}</span>
          </Button>
        )
      })}
      {canEdit ? (
        <span className="ms-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Move slide earlier"
            disabled={current === 0}
            onClick={() => {
              onChange(moveSlide(document, current, -1))
              onSelect(current - 1)
            }}
          >
            <CaretLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Move slide later"
            disabled={current === document.slides.length - 1}
            onClick={() => {
              onChange(moveSlide(document, current, 1))
              onSelect(current + 1)
            }}
          >
            <CaretRightIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete slide"
            disabled={document.slides.length <= 1}
            onClick={() => {
              onChange(removeSlide(document, current))
              onSelect(Math.max(0, current - 1))
            }}
          >
            <TrashIcon />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onChange(duplicateSlide(document, current))
              onSelect(current + 1)
            }}
          >
            <PlusIcon /> Add slide
          </Button>
        </span>
      ) : null}
    </nav>
  )
}
