'use client'

import * as React from 'react'
import { DotsThreeIcon as MoreHorizontalIcon } from '@phosphor-icons/react/dist/ssr/DotsThree'
import { PlusIcon as PlusSignIcon } from '@phosphor-icons/react/dist/ssr/Plus'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useHydratedSession } from '@/lib/auth/client'
import { availableBrandCategories, BRAND_CATEGORIES, type BrandCategory } from '@/lib/brand/apply'
import { type BrandKit, fontName } from '@/lib/brand/kit'
import {
  applyBrandKitToEditor,
  deleteBrandKit,
  loadBrandKits,
  useBrandKits,
} from '@/lib/brand/library'
import { useImageStore } from '@/lib/store'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { SectionWrapper } from '../sections/SectionWrapper'
import { BrandKitDialog } from './BrandKitDialog'

const CATEGORY_LABELS: Record<BrandCategory, string> = {
  background: 'Background',
  colors: 'Colours',
  frame: 'Frame',
  logo: 'Logo',
  typography: 'Fonts',
}

function available(kit: BrandKit, category: BrandCategory): boolean {
  return availableBrandCategories(kit).includes(category)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'That did not work. Try again.'
}

/**
 * Put the design on brand: pick a workspace brand kit and the parts to
 * apply. Applying again keeps what the user changed since, and says so.
 * Owners and admins also create, edit, and delete kits here.
 */
export function BrandSection() {
  const { data: session, isPending } = useHydratedSession()
  const trpcClient = useTRPCClient()
  const { canManage, error, kits, loading } = useBrandKits()
  const binding = useImageStore((state) => state.brand)
  const [selectedName, setSelectedName] = React.useState<string | null>(null)
  const [categories, setCategories] = React.useState<ReadonlySet<BrandCategory>>(
    new Set(BRAND_CATEGORIES)
  )
  const [editing, setEditing] = React.useState<{ kit?: BrandKit } | null>(null)
  const [deleting, setDeleting] = React.useState<BrandKit | null>(null)
  const [applying, setApplying] = React.useState(false)
  // The toast's "Reset overrides" calls apply from outside a render: guard with a ref.
  const applyingRef = React.useRef(false)

  React.useEffect(() => {
    if (session) void loadBrandKits(trpcClient).catch(() => undefined)
  }, [session, trpcClient])

  if (isPending) return null

  const selected =
    kits.find((kit) => kit.name === selectedName) ??
    kits.find((kit) => kit.name === binding?.name) ??
    kits[0]
  const chosen = selected
    ? BRAND_CATEGORIES.filter(
        (category) => categories.has(category) && available(selected, category)
      )
    : []

  async function apply(kit: BrandKit, resetOverrides = false) {
    if (applyingRef.current) return
    applyingRef.current = true
    setApplying(true)
    try {
      const kept = await applyBrandKitToEditor(trpcClient, kit, chosen, { resetOverrides })
      if (kept.length > 0) {
        toast.success(`Applied ${kit.name}`, {
          action: { label: 'Reset overrides', onClick: () => void apply(kit, true) },
          description: `Kept ${kept.length} ${kept.length === 1 ? 'property' : 'properties'} you changed.`,
        })
      } else {
        toast.success(`Applied ${kit.name}`)
      }
    } catch (failure) {
      toast.error('Could not apply the brand kit', { description: errorMessage(failure) })
    } finally {
      applyingRef.current = false
      setApplying(false)
    }
  }

  return (
    <SectionWrapper
      action={
        session && canManage ? (
          <Button variant="custom" size={null}
            aria-label="New brand kit"
            className="flex h-6 items-center gap-1 rounded-md bg-muted/60 px-2 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => setEditing({})}
            type="button"
          >
            <PlusSignIcon size={10} />
            New
          </Button>
        ) : null
      }
      title="Visual brand kits"
    >
      {!session ? (
        <p className="px-2 text-[11px] text-muted-foreground">
          Sign in to use your workspace&apos;s brand kits.
        </p>
      ) : error ? (
        <p className="px-2 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      ) : kits.length === 0 ? (
        <p className="px-2 text-[11px] text-muted-foreground">
          {loading
            ? 'Loading brand kits…'
            : canManage
              ? 'Create a brand kit with your colours, fonts, logos, and default background and frame.'
              : 'Your workspace has no brand kits yet. Owners and admins can create them.'}
        </p>
      ) : (
        <div className="space-y-2.5">
          <ul aria-label="Visual brand kits" className="space-y-1">
            {kits.map((kit) => {
              const isSelected = kit.name === selected?.name
              return (
                <li className="relative" key={kit.id}>
                  <Button variant="custom" size={null}
                    aria-pressed={isSelected}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 pr-7 text-left transition-colors',
                      isSelected
                        ? 'border-foreground/30 bg-accent/60'
                        : 'border-foreground/10 hover:border-foreground/20'
                    )}
                    onClick={() => setSelectedName(kit.name)}
                    type="button"
                  >
                    <span aria-hidden className="flex -space-x-1">
                      {[
                        kit.colors.background,
                        kit.colors.foreground,
                        kit.accent,
                        kit.colors.secondary,
                      ]
                        .filter((color): color is string => Boolean(color))
                        .map((color, index) => (
                          <span
                            className="size-3.5 rounded-full border border-foreground/20"
                            key={`${color}-${index}`}
                            style={{ background: color }}
                          />
                        ))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-medium">{kit.name}</span>
                      <span className="block truncate text-[9px] text-muted-foreground">
                        {kit.primaryFont ? fontName(kit.primaryFont) : 'No font'}
                        {kit.logos.length
                          ? ` · ${kit.logos.length} logo${kit.logos.length > 1 ? 's' : ''}`
                          : ''}
                        {binding?.name === kit.name ? ` · applied (v${binding.version})` : ''}
                      </span>
                    </span>
                  </Button>
                  {canManage ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={`${kit.name} options`}
                        className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <MoreHorizontalIcon size={12} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditing({ kit })}>
                          Edit…
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onSelect={() => setDeleting(kit)}
                        >
                          Delete…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </li>
              )
            })}
          </ul>

          {selected ? (
            <>
              <div aria-label="Parts to apply" className="flex flex-wrap gap-1" role="group">
                {BRAND_CATEGORIES.map((category) => {
                  const enabled = available(selected, category)
                  const on = enabled && categories.has(category)
                  return (
                    <Button variant="custom" size={null}
                      aria-pressed={on}
                      className={cn(
                        'h-6 rounded-md border px-2 text-[10px] transition-colors disabled:opacity-40',
                        on
                          ? 'border-foreground/30 bg-foreground text-background'
                          : 'border-foreground/15 text-muted-foreground'
                      )}
                      disabled={!enabled}
                      key={category}
                      onClick={() =>
                        setCategories((current) => {
                          const next = new Set(current)
                          if (next.has(category)) next.delete(category)
                          else next.add(category)
                          return next
                        })
                      }
                      title={
                        enabled
                          ? undefined
                          : `${selected.name} has no ${CATEGORY_LABELS[category].toLowerCase()}`
                      }
                      type="button"
                    >
                      {CATEGORY_LABELS[category]}
                    </Button>
                  )
                })}
              </div>
              <Button
                className="h-8 w-full text-xs"
                disabled={applying || chosen.length === 0}
                onClick={() => void apply(selected)}
                type="button"
              >
                {applying ? 'Applying…' : `Apply ${selected.name}`}
              </Button>
            </>
          ) : null}
        </div>
      )}

      <BrandKitDialog
        kit={editing?.kit}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={(name) => {
          setSelectedName(name)
          toast.success(`Saved ${name}`)
        }}
        open={editing !== null}
      />
      <AlertDialog onOpenChange={(open) => !open && setDeleting(null)} open={deleting !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The kit leaves your workspace. Designs that use it keep their colours, fonts, and
              logos.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const kit = deleting
                if (!kit) return
                deleteBrandKit(trpcClient, kit)
                  .then(() => toast.success(`Deleted ${kit.name}`))
                  .catch((failure: unknown) => toast.error(errorMessage(failure)))
              }}
            >
              Delete brand kit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionWrapper>
  )
}
