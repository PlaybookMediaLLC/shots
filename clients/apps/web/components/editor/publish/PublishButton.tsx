'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useShallow } from 'zustand/react/shallow'
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/ssr/PaperPlaneTilt'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { getAspectRatioPreset } from '@/lib/aspect-ratio-utils'
import { useHydratedSession } from '@/lib/auth/client'
import { draftsApi } from '@/lib/content-drafts/client'
import { canExportMotion } from '@/lib/editor/canvas-content'
import { safeBaseName } from '@/lib/export/naming'
import { useExportSettings } from '@/lib/export/use-export-settings'
import { draftPostBody } from '@/lib/platform/asset-handoff'
import { useCanStartPost } from '@/lib/platform/can-start-post'
import { readEditorReturn } from '@/lib/platform/editor-handoff'
import { startIncomingMedia } from '@/lib/platform/incoming-media'
import {
  preparePublication,
  publishKindLabel,
  publishKinds,
  type PublishKind,
} from '@/lib/platform/publish-handoff'
import { useProjectSession } from '@/lib/projects/session'
import { useImageStore } from '@/lib/store'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'

/**
 * The editor's Publish action, beside Share and Export.
 *
 * It opens a draft in the publishing workspace at once — the full composer,
 * over the design — and exports the design behind it, so a person writes
 * while a video encodes. The export arrives in the composer when it is
 * stored (`lib/platform/incoming-media.ts`).
 *
 * A design with one picture publishes straight away. One with slides or
 * motion asks which of them to post first, and an editor opened from a draft
 * (or that has already published one in this session) asks whether to add
 * to it or start another post.
 */

/** The draft this editor last opened in Publish, so the next export can join it. */
let lastDraftId: string | null = null

type Where = 'new' | 'draft'

export function PublishButton({
  compact = false,
  disabled,
}: {
  compact?: boolean
  disabled: boolean
}) {
  const canStartPost = useCanStartPost()
  const router = useRouter()
  const trpcClient = useTRPCClient()
  const [settings] = useExportSettings()
  const workspaceId = useHydratedSession().data?.session.activeOrganizationId ?? ''
  const design = useImageStore(
    useShallow((state) => ({
      canAnimate: canExportMotion(state),
      customDimensions: state.customDimensions,
      hasTimeline: state.timeline.tracks.length > 0,
      imageName: state.imageName,
      selectedAspectRatio: state.selectedAspectRatio,
      slideCount: state.slides.length,
    }))
  )
  const kinds = publishKinds(design)
  const [open, setOpen] = React.useState(false)
  const [kind, setKind] = React.useState<PublishKind>('image')
  const [where, setWhere] = React.useState<Where>('new')
  const [target, setTarget] = React.useState<{ id: string; returned: boolean } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // One key per post being started: a retry after a lost response gets the
  // same draft back instead of a second one.
  const requestKey = React.useRef(crypto.randomUUID())

  if (!canStartPost) return null

  const chosen = kinds.includes(kind) ? kind : 'image'

  const publish = async (what: PublishKind, to: Where, draft: string | null) => {
    setBusy(true)
    setError(null)
    try {
      const draftId =
        to === 'draft' && draft
          ? draft
          : (
              await draftsApi.create({
                body: draftPostBody({ media: [] }),
                requestKey: requestKey.current,
              })
            ).id
      requestKey.current = crypto.randomUUID()
      lastDraftId = draftId
      const preset = getAspectRatioPreset(design.selectedAspectRatio)
      startIncomingMedia(draftId, publishKindLabel(what, design.slideCount), (onProgress) =>
        preparePublication(what, {
          canvas: preset
            ? { height: preset.height, width: preset.width }
            : { height: 1440, width: 1920 },
          hasTimeline: design.hasTimeline,
          name: safeBaseName(design.imageName ?? ''),
          onProgress,
          projectId: useProjectSession.getState().projectId ?? undefined,
          scope: workspaceId,
          settings,
          trpcClient,
        })
      )
      setOpen(false)
      router.push(`/publish/${encodeURIComponent(draftId)}`)
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'The post could not be started. Try again.'
      )
      setOpen(true)
    } finally {
      setBusy(false)
    }
  }

  const begin = () => {
    const returned = readEditorReturn(window.location.search).draftId ?? null
    const draft = returned ?? lastDraftId
    setTarget(draft ? { id: draft, returned: Boolean(returned) } : null)
    setWhere(draft ? 'draft' : 'new')
    // Nothing to choose: publish the picture into a new post.
    if (kinds.length === 1 && !draft) void publish('image', 'new', null)
    else setOpen(true)
  }

  return (
    <Popover onOpenChange={(next) => (next ? begin() : !busy && setOpen(false))} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Publish"
          className={cn(
            'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-foreground/[0.08] text-[13px] font-medium text-foreground',
            'transition-colors duration-150 hover:bg-foreground/[0.06] disabled:pointer-events-none disabled:opacity-35',
            compact ? 'px-2' : 'px-3'
          )}
          disabled={disabled || busy}
          size={null}
          type="button"
          variant="custom"
        >
          <PaperPlaneTiltIcon size={15} />
          {/* Named in full from xl up, like Export Video, so the header fits a laptop. */}
          {!compact ? (
            <span className="hidden xl:inline">{busy ? 'Opening…' : 'Publish'}</span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-72 gap-4 p-4" data-testid="publish-menu">
        {kinds.length > 1 ? (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-xs font-medium text-foreground">
              Publish this design as
            </legend>
            <RadioGroup onValueChange={(value) => setKind(value as PublishKind)} value={chosen}>
              {kinds.map((option) => (
                <Label className="flex items-center gap-2 text-xs font-normal" key={option}>
                  <RadioGroupItem value={option} />
                  {publishKindLabel(option, design.slideCount)}
                </Label>
              ))}
            </RadioGroup>
          </fieldset>
        ) : null}
        {target ? (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-xs font-medium text-foreground">Into</legend>
            <RadioGroup onValueChange={(value) => setWhere(value as Where)} value={where}>
              <Label className="flex items-center gap-2 text-xs font-normal">
                <RadioGroupItem value="draft" />
                {target.returned ? 'The draft you came from' : 'The draft you opened last'}
              </Label>
              <Label className="flex items-center gap-2 text-xs font-normal">
                <RadioGroupItem value="new" />A new post
              </Label>
            </RadioGroup>
          </fieldset>
        ) : null}
        <p className="text-[11px] text-muted-foreground">
          Publish opens over the design and the export joins the post when it is ready. Your design
          stays as it is.
        </p>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button
          disabled={busy}
          onClick={() => void publish(chosen, where, target?.id ?? null)}
          size="sm"
          type="button"
        >
          {busy ? 'Opening…' : 'Open Publish'}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
