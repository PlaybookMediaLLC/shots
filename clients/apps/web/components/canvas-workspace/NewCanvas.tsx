'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTRPCClient } from '@/lib/trpc/react'
import type { TRPCClient } from '@trpc/client'
import type { AppRouter } from '@/lib/trpc/router'
import {
  blankArtboard,
  buildRecipe,
  CANVAS_RECIPES,
  canvasRecipeSchema,
  recipeOutcomeSchema,
  type CanvasRecipe,
  type RecipeInput,
  type RecipeScreenshot,
} from '@/lib/canvas/recipes'
import { artboardFromDesign, artboardFromProject, artboardsFromStorySet } from '@/lib/canvas/import'
import {
  canvasIntent,
  createCanvas,
  screenshotFromAsset,
  screenshotFromFile,
  type CanvasIntent,
} from '@/lib/canvas/create'
import { type Artboard } from '@/lib/canvas/document'
import { releaseCanvas, stacked } from '@/lib/canvas/plan'
import { usePrivateCreativeSurface } from '@/components/creative-sets/use-private-surface'
import { RecipePreview } from './RecipePreview'
import { StartArt } from './StartArt'
import {
  CampaignDesignPicker,
  ProjectPicker,
  ReleasePicker,
  StorySetPicker,
  type ReleaseChoice,
} from './sources'

/** Ways to start a canvas. */
const startSchema = z.enum([
  'screenshots',
  'feature',
  'template',
  'launch',
  'campaign',
  'project',
  'story-set',
])
type Start = z.infer<typeof startSchema>

/** Query parameters that start a canvas from an existing record, for links from other pages. */
export type NewCanvasSource = {
  /** Preselect a way to start without creating anything yet. */
  start?: string
  recipe?: string
  project?: string
  set?: string
  design?: string
  blank?: boolean
}

type Plan = { name: string; artboards: Artboard[] }

/** Artboards from records the workspace already has. */
async function planFromSource(
  client: TRPCClient<AppRouter>,
  source: NewCanvasSource
): Promise<Plan | null> {
  if (source.project) {
    const project = await client.project.get.query({ projectId: source.project })
    return { name: project.name, artboards: [await artboardFromProject(project, { x: 0, y: 0 })] }
  }
  if (source.set) {
    const set = await client.creativeSet.get.query({ creativeSetId: source.set })
    return { name: set.name, artboards: await artboardsFromStorySet(set, { x: 0, y: 0 }) }
  }
  if (source.design) {
    const { design } = await client.design.get.query({ designId: source.design })
    return { name: design.name, artboards: [await artboardFromDesign(design, { x: 0, y: 0 })] }
  }
  const recipe = canvasRecipeSchema.safeParse(source.recipe)
  if (recipe.success)
    return { name: CANVAS_RECIPES[recipe.data].name, artboards: buildRecipe(recipe.data, {}) }
  if (source.blank)
    return { name: 'Untitled canvas', artboards: [blankArtboard('wide-16x9', { x: 0, y: 0 })] }
  return null
}

/** Stack groups of artboards in rows, one row per group, so several starts never overlap. */
export function NewCanvas({
  canEdit,
  campaignsEnabled,
  source,
}: {
  canEdit: boolean
  campaignsEnabled: boolean
  source: NewCanvasSource
}) {
  usePrivateCreativeSurface()
  const client = useTRPCClient()
  const router = useRouter()
  const [start, setStart] = useState<Start | null>(
    () => startSchema.safeParse(source.start).data ?? null
  )
  const [recipe, setRecipe] = useState<CanvasRecipe | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const intent = useRef<{ key: string; intent: CanvasIntent } | null>(null)
  const automatic = Boolean(
    source.project || source.set || source.design || source.recipe || source.blank
  )
  const started = useRef(false)

  async function create(key: string, plan: () => Promise<Plan>) {
    setBusy(true)
    setError(null)
    try {
      if (source.project) {
        const opened = await client.canvas.openProject.mutate({ projectId: source.project })
        router.replace(`/canvas/${opened.id}`)
        return
      }
      if (intent.current?.key !== key) {
        const { name, artboards } = await plan()
        intent.current = { key, intent: canvasIntent(name, artboards) }
      }
      const created = await createCanvas(client, intent.current.intent)
      router.replace(`/canvas/${created.id}`)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The canvas could not be created.')
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!automatic || !canEdit || started.current) return
    started.current = true
    void create(JSON.stringify(source), async () => {
      const plan = await planFromSource(client, source)
      if (!plan) throw new Error('Nothing to start this canvas from.')
      return plan
    })
    // The source is fixed for this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!canEdit)
    return (
      <main className="p-8">
        <p className="text-sm text-muted-foreground">
          Your role can view canvases but not create them.
        </p>
      </main>
    )

  if (automatic)
    return (
      <main className="grid min-h-[60vh] place-items-center p-8" aria-busy={busy}>
        <div className="max-w-md space-y-3 text-center">
          <h1 className="text-xl font-semibold">
            {error ? 'The canvas was not created' : 'Creating your canvas…'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {error ??
              'Copying the source as editable artboards. The original stays exactly as it is.'}
          </p>
          {error ? (
            <div className="flex justify-center gap-2">
              <Button variant="outline" asChild>
                <Link href="/canvas">Back to Canvas</Link>
              </Button>
              <Button
                onClick={() =>
                  void create(JSON.stringify(source), async () => {
                    const plan = await planFromSource(client, source)
                    if (!plan) throw new Error('Nothing to start this canvas from.')
                    return plan
                  })
                }
              >
                Try again
              </Button>
            </div>
          ) : null}
        </div>
      </main>
    )

  const choices: { id: Start; title: string; detail: string; hidden?: boolean }[] = [
    {
      id: 'screenshots',
      title: 'From product screenshots',
      detail: 'One announcement per screenshot, ready to edit.',
    },
    {
      id: 'feature',
      title: 'Announce a shipped feature',
      detail: 'Pick a release; its feature names and screenshots are quoted, not invented.',
    },
    {
      id: 'template',
      title: 'Start from a template',
      detail: 'Launches, walkthroughs, comparisons, explainers and social packs.',
    },
    {
      id: 'launch',
      title: 'Product launch presentation',
      detail: 'Problem, product, features, benefit and call to action.',
    },
    {
      id: 'campaign',
      title: 'Edit a campaign creative',
      detail: 'Copy a generated or approved design. The approved version never changes.',
      hidden: !campaignsEnabled,
    },
    {
      id: 'project',
      title: 'Import a project',
      detail: 'A lossless copy of a screenshot editor project.',
    },
    {
      id: 'story-set',
      title: 'Open a Story Set',
      detail: 'Every format of a Story Set as editable artboards.',
    },
  ]
  const visible = choices.filter((choice) => !choice.hidden)
  const chosen = visible.find((choice) => choice.id === start)

  return (
    <main
      className="mx-auto w-full space-y-8 px-4 pt-8 pb-16 md:max-w-[1200px] md:px-10"
      aria-busy={busy}
    >
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/canvas" className="text-sm text-muted-foreground hover:text-foreground">
            ← Canvas
          </Link>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">New canvas</h1>
          <p className="mt-2 max-w-xl text-muted-foreground">
            Pick a starting point. Everything it creates stays fully editable.
          </p>
        </div>
        <Button
          disabled={busy}
          onClick={() =>
            void create('blank', async () => ({
              name: 'Untitled canvas',
              artboards: [blankArtboard('wide-16x9', { x: 0, y: 0 })],
            }))
          }
        >
          Blank canvas
        </Button>
      </header>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {chosen ? (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          <aside className="grid gap-4 lg:sticky lg:top-8">
            <Button
              className="cursor-pointer justify-self-start rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
              onClick={() => {
                setStart(null)
                setRecipe(null)
              }}
              size={null}
              type="button"
              variant="custom"
            >
              ← All ways to start
            </Button>
            <StartArt className="hidden sm:block" start={chosen.id} />
            <div>
              <h2 className="font-medium">{chosen.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{chosen.detail}</p>
            </div>
          </aside>
          <section
            aria-label="Starting point"
            className="min-h-64 rounded-xl border bg-[var(--platform-group,var(--card))] p-5"
          >
            {start === 'screenshots' ? (
              <ScreenshotStart
                disabled={busy}
                onCreate={(shots) =>
                  void create(`shots:${shots.map((shot) => shot.src).join(',')}`, async () => ({
                    name: 'Product screenshots',
                    artboards: stacked(
                      ...shots.map((shot) =>
                        buildRecipe('feature-announcement', { screenshots: [shot] })
                      )
                    ),
                  }))
                }
              />
            ) : null}
            {start === 'feature' ? (
              <ReleasePicker
                disabled={busy}
                onPick={(choice) =>
                  void create(`release:${choice.release.id}:${choice.featureIndex ?? 'all'}`, () =>
                    featurePlan(client, choice)
                  )
                }
              />
            ) : null}
            {start === 'template' && !recipe ? <RecipeGallery onPick={setRecipe} /> : null}
            {(start === 'template' || start === 'launch') && recipe ? (
              <RecipeForm
                recipe={recipe}
                disabled={busy}
                onBack={start === 'template' ? () => setRecipe(null) : undefined}
                onCreate={(input) =>
                  void create(`recipe:${recipe}:${JSON.stringify(input)}`, async () => ({
                    name: CANVAS_RECIPES[recipe].name,
                    artboards: buildRecipe(recipe, input),
                  }))
                }
              />
            ) : null}
            {start === 'campaign' ? (
              <CampaignDesignPicker
                disabled={busy}
                onPick={(id) =>
                  void create(
                    `design:${id}`,
                    async () => (await planFromSource(client, { design: id }))!
                  )
                }
              />
            ) : null}
            {start === 'project' ? (
              <ProjectPicker
                disabled={busy}
                onPick={(id) =>
                  void create(
                    `project:${id}`,
                    async () => (await planFromSource(client, { project: id }))!
                  )
                }
              />
            ) : null}
            {start === 'story-set' ? (
              <StorySetPicker
                disabled={busy}
                onPick={(id) =>
                  void create(`set:${id}`, async () => (await planFromSource(client, { set: id }))!)
                }
              />
            ) : null}
            {busy ? (
              <p className="mt-4 text-sm text-muted-foreground" role="status">
                Creating your canvas…
              </p>
            ) : null}
          </section>
        </div>
      ) : (
        <nav aria-label="Ways to start" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((choice) => (
            <Button
              variant="custom"
              size={null}
              key={choice.id}
              type="button"
              onClick={() => {
                setStart(choice.id)
                setRecipe(choice.id === 'launch' ? 'product-launch' : null)
              }}
              className="group flex min-w-0 flex-col items-stretch rounded-xl border bg-card p-1.5 text-left transition-[border-color,box-shadow] duration-150 hover:border-foreground/20 hover:shadow-md focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
            >
              <StartArt start={choice.id} />
              <span className="block px-2.5 pt-3 pb-2">
                <span className="flex items-center justify-between gap-2 font-medium">
                  {choice.title}
                  <span
                    aria-hidden="true"
                    className="text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground"
                  >
                    →
                  </span>
                </span>
                <span className="mt-1 block text-xs leading-normal text-muted-foreground">
                  {choice.detail}
                </span>
              </span>
            </Button>
          ))}
        </nav>
      )}
    </main>
  )
}

/** A grounded announcement plus channel formats, from a release's own record. */
async function featurePlan(client: TRPCClient<AppRouter>, choice: ReleaseChoice): Promise<Plan> {
  const shots: RecipeScreenshot[] = []
  for (const [index, assetId] of choice.screenshotAssetIds.slice(0, 2).entries())
    shots.push(await screenshotFromAsset(client, assetId, `${choice.release.title} ${index + 1}`))
  const input: RecipeInput = {
    release: choice.release,
    featureIndex: choice.featureIndex,
    screenshots: shots,
  }
  const feature =
    choice.featureIndex !== undefined
      ? choice.release.features[choice.featureIndex]?.title
      : undefined
  return {
    name: feature ?? choice.release.title,
    artboards: releaseCanvas(['feature-announcement', 'social-pack'], input),
  }
}

function ScreenshotStart({
  onCreate,
  disabled,
}: {
  onCreate: (shots: RecipeScreenshot[]) => void
  disabled?: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="grid gap-3">
      <Label className="grid gap-2 text-sm">
        Choose up to six screenshots
        <FileDropZone
          accept={{ 'image/png': [], 'image/jpeg': [], 'image/webp': [] }}
          disabled={disabled}
          hint="Up to six PNG, JPEG or WebP images."
          label="Screenshots"
          multiple
          onFiles={async (chosen) => {
            const files = chosen.slice(0, 6)
            if (!files.length) return
            try {
              setError(null)
              onCreate(await Promise.all(files.map(screenshotFromFile)))
            } catch (error) {
              setError(error instanceof Error ? error.message : 'That image could not be read.')
            }
          }}
        />
      </Label>
      <p className="text-xs text-muted-foreground">
        Images upload to this workspace&apos;s assets when the canvas is created.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Recipes grouped by what they help a team do. */
export function RecipeGallery({ onPick }: { onPick: (recipe: CanvasRecipe) => void }) {
  const labels = {
    announce: 'Announce',
    launch: 'Launch',
    explain: 'Explain',
    compare: 'Compare',
    distribute: 'Distribute',
  }
  return (
    <div className="grid gap-5">
      {recipeOutcomeSchema.options.map((outcome) => (
        <section key={outcome} aria-label={labels[outcome]} className="grid gap-2">
          <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {labels[outcome]}
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {canvasRecipeSchema.options
              .filter((recipe) => CANVAS_RECIPES[recipe].outcome === outcome)
              .map((recipe) => (
                <Button
                  variant="custom"
                  size={null}
                  key={recipe}
                  type="button"
                  aria-label={CANVAS_RECIPES[recipe].name}
                  onClick={() => onPick(recipe)}
                  className="flex min-w-0 flex-col rounded-lg border p-3 text-left hover:bg-foreground/[0.03] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
                >
                  <RecipePreview recipe={recipe} />
                  <span className="block text-ui-lg font-medium">{CANVAS_RECIPES[recipe].name}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {CANVAS_RECIPES[recipe].description}
                  </span>
                  <span className="mt-auto block pt-2 text-[11px] text-muted-foreground">
                    {CANVAS_RECIPES[recipe].artboards}
                  </span>
                </Button>
              ))}
          </div>
        </section>
      ))}
      <p className="text-xs text-muted-foreground">
        App Store and Google Play screenshots keep their own studio and renderer:{' '}
        <Link className="underline" href="/store-screenshots">
          open App Store Screenshots
        </Link>
        .
      </p>
    </div>
  )
}

/** The few inputs a recipe uses; everything left empty becomes a clearly marked placeholder. */
export function RecipeForm({
  recipe,
  onCreate,
  onBack,
  disabled,
  submitLabel = 'Create',
}: {
  recipe: CanvasRecipe
  onCreate: (input: RecipeInput) => void
  onBack?: () => void
  disabled?: boolean
  submitLabel?: string
}) {
  const info = CANVAS_RECIPES[recipe]
  const [headline, setHeadline] = useState('')
  const [supporting, setSupporting] = useState('')
  const [steps, setSteps] = useState('')
  const [code, setCode] = useState('')
  const [shots, setShots] = useState<RecipeScreenshot[]>([])
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        onCreate({
          headline: headline.trim() || undefined,
          supporting: supporting.trim() || undefined,
          screenshots: shots,
          steps: steps
            .split('\n')
            .map((step) => step.trim())
            .filter(Boolean)
            .slice(0, 6),
          code: code.trim() || undefined,
        })
      }}
    >
      {onBack ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="justify-self-start px-0"
          onClick={onBack}
        >
          ← All templates
        </Button>
      ) : null}
      <div>
        <h2 className="font-medium">{info.name}</h2>
        <p className="text-xs text-muted-foreground">{info.description}</p>
      </div>
      <Label className="grid gap-1 text-sm">
        Headline
        <Input
          value={headline}
          maxLength={300}
          placeholder="What did you ship?"
          onChange={(event) => setHeadline(event.target.value)}
        />
      </Label>
      <Label className="grid gap-1 text-sm">
        Supporting line
        <Input
          value={supporting}
          maxLength={300}
          placeholder="Why it matters to your customer"
          onChange={(event) => setSupporting(event.target.value)}
        />
      </Label>
      {recipe === 'walkthrough' ? (
        <Label className="grid gap-1 text-sm">
          Steps, one per line
          <Textarea value={steps} rows={4} onChange={(event) => setSteps(event.target.value)} />
        </Label>
      ) : null}
      {recipe === 'technical-explainer' ? (
        <Label className="grid gap-1 text-sm">
          Code
          <Textarea
            value={code}
            rows={6}
            className="font-mono text-xs"
            maxLength={4000}
            onChange={(event) => setCode(event.target.value)}
          />
        </Label>
      ) : null}
      {info.screenshots > 0 || recipe === 'walkthrough' || recipe === 'release-announcement' ? (
        <Label className="grid gap-1 text-sm">
          {recipe === 'before-after' ? 'Before and after screenshots' : 'Screenshots'}
          <FileDropZone
            accept={{ 'image/png': [], 'image/jpeg': [], 'image/webp': [] }}
            hint="Up to six PNG, JPEG or WebP images."
            label="Screenshots"
            multiple
            onFiles={async (chosen) => {
              const files = chosen.slice(0, 6)
              try {
                setError(null)
                setShots(await Promise.all(files.map(screenshotFromFile)))
              } catch (error) {
                setError(error instanceof Error ? error.message : 'That image could not be read.')
              }
            }}
          />
          <span className="text-xs text-muted-foreground">
            {shots.length
              ? shots.map((shot) => shot.name).join(', ')
              : 'Optional: placeholders keep the layout until you add one.'}
          </span>
        </Label>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={disabled} className="justify-self-start">
        {submitLabel}
      </Button>
    </form>
  )
}
