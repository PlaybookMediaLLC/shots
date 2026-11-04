'use client'

import { useEffect } from 'react'
import { ArrowForwardIcon as ArrowRight, BrushIcon } from '@/components/platform-shell/icons'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { EmptyState } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { fontName } from '@/lib/brand/kit'
import { loadBrandKits, useBrandKits } from '@/lib/brand/library'
import { assetContentUrl } from '@/lib/editor/services'
import { useTRPCClient } from '@/lib/trpc/react'

/** Brand kits are edited in Settings; Library shows them where work is made. */
const EDIT_HREF = '/settings/brand-kit'

/** The workspace's visual brand kits, read-only: logos, colours and fonts. */
export function BrandAssets() {
  const client = useTRPCClient()
  const { error, kits, loading } = useBrandKits()
  // A failed load is kept in the store and shown below with a retry.
  const load = () => void loadBrandKits(client).catch(() => undefined)
  useEffect(() => {
    void loadBrandKits(client).catch(() => undefined)
  }, [client])

  if (error) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
      >
        <p>{error}</p>
        <Button size="sm" variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    )
  }
  if (loading && !kits.length) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading brand assets…
      </p>
    )
  }
  if (!kits.length) {
    return (
      <EmptyState
        icon={BrushIcon}
        title="No brand kits yet"
        description="A brand kit holds the logos, colours and fonts your visuals use."
        action={<ButtonLink href={EDIT_HREF}>Create one in Settings</ButtonLink>}
      />
    )
  }
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Visual brand kits · Applied from the editors
        </p>
        <ButtonLink href={EDIT_HREF} variant="outline" className="gap-2">
          Edit in Settings <ArrowRight size={15} aria-hidden="true" />
        </ButtonLink>
      </div>
      <ul className="grid gap-3 md:grid-cols-2">
        {kits.map((kit) => {
          const colors = [
            kit.colors.background,
            kit.colors.foreground,
            kit.accent,
            ...(kit.colors.secondary ? [kit.colors.secondary] : []),
            ...kit.colors.palette,
          ]
          const fonts = [
            ...new Set([kit.primaryFont, kit.secondaryFont].filter((font) => font !== null)),
          ]
          return (
            <li className="grid gap-4 rounded-xl border border-border bg-card p-4" key={kit.id}>
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="truncate text-ui-lg font-medium">{kit.name}</h2>
                <span className="shrink-0 text-xs text-muted-foreground">v{kit.version}</span>
              </div>
              {kit.logos.length ? (
                <ul aria-label="Logos" className="flex flex-wrap gap-2">
                  {kit.logos.map((logo) => (
                    <li
                      className="grid size-16 place-items-center rounded-lg border border-border bg-background p-2"
                      key={logo.id}
                    >
                      {/* Private endpoint: next/image's shared optimizer must not cache tenant content. */}
                      <img
                        alt={logo.name}
                        className="max-h-full max-w-full object-contain"
                        loading="lazy"
                        src={
                          logo.src.startsWith('asset:')
                            ? assetContentUrl(logo.src.slice('asset:'.length))
                            : logo.src
                        }
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              <ul aria-label="Colours" className="flex flex-wrap gap-2">
                {[...new Set(colors)].map((color) => (
                  <li
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                    key={color}
                  >
                    <span
                      aria-hidden="true"
                      className="size-5 rounded-md border border-border"
                      style={{ background: color }}
                    />
                    {color}
                  </li>
                ))}
              </ul>
              {fonts.length ? (
                <p className="text-sm">
                  <span className="text-muted-foreground">Fonts · </span>
                  {fonts.map(fontName).join(', ')}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
