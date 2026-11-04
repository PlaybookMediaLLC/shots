'use client'

import type { ProductSurface, SurfaceCapture } from 'screenshot-studio-backend-sdk'
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { Group, Pill, type PillTone, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import {
  captureFailureMessage,
  type SurfaceFreshness,
  surfaceFreshness,
} from '@/lib/tenant/surface-freshness'
import { useTRPCClient } from '@/lib/trpc/react'
import { getErrorMessage } from './settings-client'
import { Label } from '@/components/ui/label'

type Surface = Pick<
  ProductSurface,
  | 'description'
  | 'featureTags'
  | 'id'
  | 'lastCaptureFailureCode'
  | 'lastCapturedAt'
  | 'name'
  | 'slug'
  | 'url'
>

const FRESHNESS: Record<SurfaceFreshness, { label: string; tone: PillTone }> = {
  fresh: { label: 'Fresh', tone: 'green' },
  never: { label: 'Never captured', tone: 'gray' },
  stale: { label: 'Stale', tone: 'yellow' },
}

const SOURCES: Record<SurfaceCapture['source'], string> = {
  agent: 'Campaign studio',
  deployment: 'Deployment',
  manual: 'Captured by hand',
  release: 'Release',
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/** "3 days ago", "2 months ago"; the server renders UTC, so hydration may differ. */
function Ago({ value }: { value: string }) {
  const days = Math.round((new Date(value).getTime() - Date.now()) / 86_400_000)
  const label =
    Math.abs(days) < 60
      ? RELATIVE.format(days, 'day')
      : RELATIVE.format(Math.round(days / 30), 'month')
  return (
    <time dateTime={value} suppressHydrationWarning title={new Date(value).toLocaleString()}>
      {label}
    </time>
  )
}

/** Comma-separated tags as a list, trimmed and without repeats. */
function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    ),
  ]
}

/** Adds a surface, or edits one; the slug is set from the name once and never changes. */
function SurfaceForm({
  onCancel,
  onSaved,
  surface,
}: {
  onCancel?: () => void
  onSaved: () => void
  surface?: Surface
}) {
  const trpcClient = useTRPCClient()
  const id = useId()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const text = (name: string) => String(data.get(name) ?? '').trim()
    const fields = {
      description: text('description'),
      featureTags: parseTags(text('featureTags')),
      name: text('name'),
      url: text('url'),
    }
    setError(null)
    setBusy(true)
    try {
      if (surface) {
        await trpcClient.productSurface.update.mutate({ surfaceId: surface.id, ...fields })
      } else {
        await trpcClient.productSurface.create.mutate({
          ...fields,
          description: fields.description || undefined,
        })
        form.reset()
      }
      onSaved()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="flex w-full flex-col gap-3" onSubmit={handleSubmit}>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-foreground/65" htmlFor={`${id}-name`}>
            Name
          </Label>
          <Input
            className="h-10 rounded-lg"
            defaultValue={surface?.name}
            id={`${id}-name`}
            maxLength={160}
            name="name"
            placeholder="Invoice approvals"
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-foreground/65" htmlFor={`${id}-url`}>
            URL
          </Label>
          <Input
            className="h-10 rounded-lg"
            defaultValue={surface?.url}
            id={`${id}-url`}
            maxLength={2_000}
            name="url"
            placeholder="https://app.example.com/invoices"
            required
            type="url"
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-medium text-foreground/65" htmlFor={`${id}-tags`}>
          Feature tags
        </Label>
        <Input
          aria-describedby={`${id}-tags-hint`}
          className="h-10 rounded-lg"
          defaultValue={surface?.featureTags.join(', ')}
          id={`${id}-tags`}
          name="featureTags"
          placeholder="approvals, invoices"
        />
        <p className="text-xs text-muted-foreground" id={`${id}-tags-hint`}>
          Comma-separated. Campaigns about a tagged feature use this page first.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-medium text-foreground/65" htmlFor={`${id}-description`}>
          Description
        </Label>
        <Textarea
          className="min-h-16 rounded-lg"
          defaultValue={surface?.description ?? ''}
          id={`${id}-description`}
          maxLength={1_000}
          name="description"
        />
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button className="rounded-lg" onClick={onCancel} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
        ) : null}
        <Button className="rounded-lg" disabled={busy} size="sm" type="submit">
          {busy ? 'Saving…' : surface ? 'Save page' : 'Add page'}
        </Button>
      </div>
    </form>
  )
}

/** A private capture asset, shown through a short-lived signed URL. */
function CaptureThumbnail({ assetId }: { assetId: string }) {
  const trpcClient = useTRPCClient()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    trpcClient.asset.signDownload
      .query({ assetId })
      .then((result) => setUrl(result.downloadUrl))
      .catch(() => undefined)
  }, [assetId, trpcClient])
  return (
    <div className="grid aspect-[16/10] w-32 shrink-0 place-items-center overflow-hidden rounded-lg bg-foreground/[0.03] ring-1 ring-foreground/[0.06]">
      {url ? (
        // A signed, short-lived storage URL, so a plain img: next/image would cache it.
        <img alt="" className="size-full object-cover object-top" loading="lazy" src={url} />
      ) : (
        <div className="size-full animate-pulse bg-foreground/[0.02]" />
      )}
    </div>
  )
}

/** Every capture of one surface, newest first; superseded captures stay readable. */
function CaptureHistory({
  onOpenChange,
  surface,
  version,
}: {
  onOpenChange: (open: boolean) => void
  surface: Surface | null
  /** Bumped after a capture, so an open history reloads. */
  version: number
}) {
  const trpcClient = useTRPCClient()
  const [captures, setCaptures] = useState<SurfaceCapture[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!surface) return
    setCaptures(null)
    setError(null)
    trpcClient.productSurface.captures
      .query({ surfaceId: surface.id })
      .then((result) => setCaptures(result.captures))
      .catch((requestError) => setError(getErrorMessage(requestError)))
  }, [surface, trpcClient, version])

  return (
    <Sheet onOpenChange={onOpenChange} open={surface !== null}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{surface?.name} captures</SheetTitle>
          <SheetDescription>
            The 50 newest screenshots. Posts keep the capture they were made with.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 pb-6">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : captures === null ? (
            <p className="text-sm text-muted-foreground">Loading captures…</p>
          ) : captures.length === 0 ? (
            <p className="text-sm text-muted-foreground">No captures yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {captures.map((capture) => (
                <li className="flex items-center gap-3" key={capture.id}>
                  <CaptureThumbnail assetId={capture.assetId} />
                  <div className="flex min-w-0 flex-col gap-1 text-xs text-foreground/65">
                    <span className="text-sm text-foreground">
                      <Ago value={capture.capturedAt} />
                    </span>
                    <span>{SOURCES[capture.source]}</span>
                    {capture.supersededAt ? null : (
                      <span>
                        <Pill tone="green">Current</Pill>
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SurfaceRow({
  canManage,
  onCaptured,
  onHistory,
  onSaved,
  surface,
}: {
  canManage: boolean
  onCaptured: () => void
  onHistory: () => void
  onSaved: () => void
  surface: Surface
}) {
  const trpcClient = useTRPCClient()
  const [editing, setEditing] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const freshness = FRESHNESS[surfaceFreshness(surface.lastCapturedAt)]

  async function capture() {
    setCapturing(true)
    try {
      await trpcClient.productSurface.capture.mutate({ surfaceId: surface.id })
      toast.success(`${surface.name} captured`)
      onCaptured()
    } catch (requestError) {
      toast.error(`${surface.name} could not be captured`, {
        description: getErrorMessage(requestError),
      })
    } finally {
      setCapturing(false)
    }
  }

  if (editing) {
    return (
      <Row>
        <SurfaceForm
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            onSaved()
          }}
          surface={surface}
        />
      </Row>
    )
  }

  return (
    <Row>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-ui-lg font-medium text-foreground">{surface.name}</h3>
            <code className="font-mono text-xs text-muted-foreground">{surface.slug}</code>
            <Pill tone={freshness.tone}>{freshness.label}</Pill>
          </div>
          <a
            className="truncate text-xs text-foreground/65 hover:text-foreground"
            href={surface.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            {surface.url}
          </a>
          {surface.featureTags.length > 0 ? (
            <ul aria-label="Feature tags" className="flex flex-wrap gap-1">
              {surface.featureTags.map((tag) => (
                <li key={tag}>
                  <Pill tone="blue">{tag}</Pill>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {surface.lastCapturedAt ? (
              <>
                Last captured <Ago value={surface.lastCapturedAt} />
              </>
            ) : (
              'Not captured yet'
            )}
          </p>
          {surface.lastCaptureFailureCode ? (
            <p className="text-xs text-red-700 dark:text-red-300" role="status">
              {captureFailureMessage(surface.lastCaptureFailureCode)}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            className="h-8 rounded-lg text-xs"
            onClick={onHistory}
            size="sm"
            type="button"
            variant="ghost"
          >
            History
          </Button>
          {canManage ? (
            <>
              <Button
                className="h-8 rounded-lg text-xs"
                onClick={() => setEditing(true)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Edit
              </Button>
              <Button
                className="h-8 rounded-lg text-xs"
                disabled={capturing}
                onClick={() => void capture()}
                size="sm"
                type="button"
                variant="outline"
              >
                {capturing ? 'Capturing…' : 'Capture now'}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </Row>
  )
}

/**
 * The workspace's product pages (RFC 018 surfaces): what each one shows, how
 * fresh its screenshot is, why the last capture failed, and every capture it
 * has had. Campaigns pick the page for a feature from these, by tag first.
 */
export function WorkspaceProductSurfaces({ canManage }: { canManage: boolean }) {
  const trpcClient = useTRPCClient()
  const [surfaces, setSurfaces] = useState<Surface[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<Surface | null>(null)
  const [captureVersion, setCaptureVersion] = useState(0)

  const load = useCallback(() => {
    trpcClient.productSurface.list
      .query()
      .then((result) => setSurfaces(result.productSurfaces))
      .catch((requestError) => setError(getErrorMessage(requestError)))
  }, [trpcClient])

  useEffect(load, [load])

  return (
    <div className="flex flex-col gap-10">
      <Section
        description="A capture older than 30 days is stale; posts can still use it, with a label."
        title="Pages"
      >
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Group>
          {surfaces === null ? (
            error ? null : (
              <Row>
                <p className="text-sm text-muted-foreground">Loading product pages…</p>
              </Row>
            )
          ) : surfaces.length === 0 ? (
            <Row>
              <p className="text-sm text-muted-foreground">No product pages yet.</p>
            </Row>
          ) : (
            surfaces.map((surface) => (
              <SurfaceRow
                canManage={canManage}
                key={surface.id}
                onCaptured={() => {
                  load()
                  setCaptureVersion((version) => version + 1)
                }}
                onHistory={() => setHistory(surface)}
                onSaved={load}
                surface={surface}
              />
            ))
          )}
        </Group>
      </Section>
      {canManage ? (
        <Section title="Add a page">
          <Group>
            <Row>
              <SurfaceForm onSaved={load} />
            </Row>
          </Group>
        </Section>
      ) : null}
      <CaptureHistory
        onOpenChange={(open) => (open ? undefined : setHistory(null))}
        surface={history}
        version={captureVersion}
      />
    </div>
  )
}
