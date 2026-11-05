'use client'

import { SlidersHorizontalIcon as Settings2 } from '@phosphor-icons/react/dist/ssr/SlidersHorizontal'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useSocialSet } from '@/components/settings/social-sets/api'
import { NewDraftPage } from '@/components/settings/social-sets/NewDraftPage'
import { PublicProfilePage } from '@/components/settings/social-sets/PublicProfilePage'
import { SchedulingPage } from '@/components/settings/social-sets/SchedulingPage'
import { WritingAssistantPage } from '@/components/settings/social-sets/WritingAssistantPage'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  SOCIAL_SET_PAGES,
  type SocialSetPage,
  socialSetHref,
} from '@/components/workspace/settings-sections'
import { settingsErrorMessage } from '@/lib/settings/client'
import { cn } from '@/lib/utils'

/**
 * The brand's settings pages the sheet shows: the full page's tabs, except
 * General, where connecting an account leaves the page to sign in.
 */
const PAGES = SOCIAL_SET_PAGES.filter((page) => page.slug !== 'general')

/**
 * Whether the address opens the sheet: a page it has. An old page in a saved
 * link (such as `appearance`, now in workspace settings) does not.
 */
export function settingsOpen(params: { get: (name: string) => string | null }): boolean {
  return PAGES.some((item) => item.slug === params.get('settings'))
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
 * A brand's settings in a sheet over the page (RFC 024): the same pages as
 * Settings › Publishing brands, named in the address (`?settings=scheduling`),
 * so opening, moving between pages and closing never unmounts the work under
 * it: unsaved text, selection, media, channel text and comments stay as they were.
 */
export function DraftSettingsDrawer({
  advancedScheduling,
  canManage,
  canWrite,
  socialSetId,
}: {
  /** Whether the plan has queue slots, so the schedule page can say so before a save fails. */
  advancedScheduling?: boolean
  /** May change the brand (workspace:update, as on its Settings page). */
  canManage: boolean
  canWrite: boolean
  /** The page's own brand, when the address names none. */
  socialSetId: string
}) {
  const router = useRouter()
  const params = useSearchParams()
  const page = PAGES.find((item) => item.slug === params.get('settings'))?.slug ?? null
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

  const name = set.data?.name ?? 'Brand'
  return (
    <Sheet onOpenChange={(open) => (open ? null : openBrandSettings(null))} open={page !== null}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl" side="right">
        <SheetHeader>
          <SheetTitle>{name} settings</SheetTitle>
          <SheetDescription>
            The same settings as Settings › Publishing brands. Changes apply to new drafts and the
            queue; open drafts keep their text.
          </SheetDescription>
        </SheetHeader>
        <nav
          aria-label="Settings pages"
          className="flex flex-wrap gap-1 border-b border-border px-4"
        >
          {PAGES.map((item) => (
            <Button
              aria-current={item.slug === page ? 'page' : undefined}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                item.slug === page
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
              key={item.slug}
              onClick={() => openBrandSettings(item.slug)}
              size={null}
              type="button"
              variant="custom"
            >
              {item.title}
            </Button>
          ))}
        </nav>
        <div className="grid gap-4 p-4">
          {set.isPending ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {set.isError ? (
            <p className="text-sm text-red-700 dark:text-red-300" role="alert">
              {settingsErrorMessage(set.error)}
            </p>
          ) : null}
          {set.data && page === 'scheduling' ? (
            <SchedulingPage
              advancedScheduling={advancedScheduling}
              canManage={canManage}
              set={set.data}
            />
          ) : null}
          {set.data && page === 'new-draft' ? (
            <NewDraftPage canManage={canManage} set={set.data} />
          ) : null}
          {set.data && page === 'public-profile' ? (
            <PublicProfilePage canManage={canManage} set={set.data} />
          ) : null}
          {set.data && page === 'writing-assistant' ? (
            <WritingAssistantPage canWrite={canWrite} set={set.data} />
          ) : null}
          <Link className="text-sm underline" href={socialSetHref(id, page ?? 'general')}>
            Open in Settings
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  )
}
