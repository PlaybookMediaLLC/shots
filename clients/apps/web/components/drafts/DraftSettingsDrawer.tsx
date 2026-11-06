'use client'

import { SlidersHorizontalIcon as Settings2 } from '@phosphor-icons/react/dist/ssr/SlidersHorizontal'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useSocialSet } from '@/components/settings/social-sets/api'
import { SchedulingPage } from '@/components/settings/social-sets/SchedulingPage'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  type SocialSetPage,
  socialSetHref,
} from '@/components/workspace/settings-sections'
import { settingsErrorMessage } from '@/lib/settings/client'

/**
 * The sheet holds what a person needs while writing: the time zone and posting
 * times. Everything else about a brand is in Settings, one link away.
 */
const SHEET_PAGE = 'scheduling'

/**
 * Whether the address opens the sheet: a page it has. An old page in a saved
 * link (such as `appearance`, now in workspace settings) does not.
 */
export function settingsOpen(params: { get: (name: string) => string | null }): boolean {
  return params.get('settings') === SHEET_PAGE
}

/**
 * Opens, moves or closes the sheet through the address, so back and forward
 * work. `brand` picks another brand than the page's own, as the Calendar does.
 */
export function openBrandSettings(page: SocialSetPage | null, brand?: string) {
  const url = new URL(window.location.href)
  if (page) url.searchParams.set('settings', page)
  else url.searchParams.delete('settings')
  if (brand) url.searchParams.set('brand', brand)
  else if (!page) url.searchParams.delete('brand')
  window.history.pushState(null, '', url)
}

/** The icon beside a draft that opens its brand's settings. */
export function BrandSettingsButton({ id, name }: { id: string; name: string }) {
  return (
    <Button
      aria-label={`Settings for ${name}`}
      className="size-8 px-0"
      onClick={() => openBrandSettings('scheduling', id)}
      size="sm"
      title={`Settings for ${name}`}
      type="button"
      variant="ghost"
    >
      <Settings2 aria-hidden className="size-4" />
    </Button>
  )
}

/**
 * A brand's scheduling settings in a sheet over the page (RFC 024), named in
 * the address (`?settings=scheduling`), so opening and closing never unmounts
 * the work under it: unsaved text, selection, media, channel text and comments
 * stay as they were.
 */
export function DraftSettingsDrawer({
  advancedScheduling,
  canManage,
  socialSetId,
}: {
  /** Whether the plan has queue slots, so the schedule page can say so before a save fails. */
  advancedScheduling?: boolean
  /** May change the brand (workspace:update, as on its Settings page). */
  canManage: boolean
  /** The page's own brand, when the address names none. */
  socialSetId: string
}) {
  const router = useRouter()
  const params = useSearchParams()
  const open = settingsOpen(params)
  const id = params.get('brand') || socialSetId
  const set = useSocialSet(id)

  // A save here changes what the page under the sheet shows (the queue, the
  // calendar's slots, the composer's defaults), so it reloads its server data.
  const shown = useRef(set.data)
  useEffect(() => {
    if (shown.current && set.data && shown.current !== set.data && shown.current.id === set.data.id)
      router.refresh()
    shown.current = set.data
  }, [router, set.data])

  const name = set.data?.name ?? 'Profile'
  return (
    <Sheet onOpenChange={(open) => (open ? null : openBrandSettings(null))} open={open}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl" side="right">
        <SheetHeader>
          <SheetTitle>{name} settings</SheetTitle>
          <SheetDescription className="sr-only">Time zone and posting times</SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 p-4">
          {set.isPending ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {set.isError ? (
            <p className="text-sm text-red-700 dark:text-red-300" role="alert">
              {settingsErrorMessage(set.error)}
            </p>
          ) : null}
          {set.data ? (
            <SchedulingPage
              advancedScheduling={advancedScheduling}
              canManage={canManage}
              set={set.data}
            />
          ) : null}
          <Link className="text-sm underline" href={socialSetHref(id, 'general')}>
            All settings for {name}
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  )
}
