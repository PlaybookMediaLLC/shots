'use client'

import { SlidersHorizontalIcon as Settings2 } from '@phosphor-icons/react/dist/ssr/SlidersHorizontal'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { z } from 'zod'
import { useSocialSet } from '@/components/settings/social-sets/api'
import { NewDraftPage } from '@/components/settings/social-sets/NewDraftPage'
import { SchedulingPage } from '@/components/settings/social-sets/SchedulingPage'
import { WritingAssistantPage } from '@/components/settings/social-sets/WritingAssistantPage'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { socialSetHref } from '@/components/workspace/settings-sections'
import { settingsErrorMessage } from '@/lib/settings/client'
import { cn } from '@/lib/utils'

/**
 * The brand settings a writer can open beside a draft. Personal preferences
 * (theme, navigation, calendar start, text direction) live in workspace
 * settings, under Appearance.
 */
const drawerPageSchema = z.enum(['scheduling', 'new-draft', 'writing-assistant'])

type DrawerPage = z.infer<typeof drawerPageSchema>

const PAGES: { page: DrawerPage; title: string }[] = [
  { page: 'scheduling', title: 'Scheduling' },
  { page: 'new-draft', title: 'New draft' },
  { page: 'writing-assistant', title: 'Writing Assistant' },
]

/**
 * Whether the address opens the drawer: a page it has. An old page in a saved
 * link (such as `appearance`, now in workspace settings) does not.
 */
export function settingsOpen(params: { get: (name: string) => string | null }): boolean {
  return drawerPageSchema.safeParse(params.get('settings')).success
}

/** Opens or moves the drawer through the address, so back and forward work. */
function go(page: DrawerPage | null) {
  const url = new URL(window.location.href)
  if (page) url.searchParams.set('settings', page)
  else url.searchParams.delete('settings')
  window.history.pushState(null, '', url)
}

/**
 * Settings beside the composer (RFC 024). The drawer is part of the draft's
 * page, named in its address (`?settings=scheduling`), so opening it, moving
 * between its pages and closing it never unmounts the editor: unsaved text,
 * selection, media, channel text and comments stay as they were.
 */
export function DraftSettingsDrawer({
  advancedScheduling,
  canManage,
  canWrite,
  socialSet,
}: {
  /** Whether the plan has queue slots, so the schedule page can say so before a save fails. */
  advancedScheduling?: boolean
  canManage: boolean
  canWrite: boolean
  socialSet: { id: string; name: string; timeZone: string }
}) {
  const parsed = drawerPageSchema.safeParse(useSearchParams().get('settings'))
  const page = parsed.success ? parsed.data : null
  const set = useSocialSet(socialSet.id)

  return (
    <>
      <Button
        aria-label={`Settings for ${socialSet.name}`}
        aria-pressed={page !== null}
        className="size-8 px-0"
        onClick={() => go('scheduling')}
        size="sm"
        title={`Settings for ${socialSet.name}`}
        type="button"
        variant="ghost"
      >
        <Settings2 aria-hidden className="size-4" />
      </Button>
      <Sheet onOpenChange={(open) => (open ? null : go(null))} open={page !== null}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl" side="right">
          <SheetHeader>
            <SheetTitle>{socialSet.name} settings</SheetTitle>
            <SheetDescription>Changes apply to new drafts and the queue; this draft keeps its text.</SheetDescription>
          </SheetHeader>
          <nav aria-label="Settings pages" className="flex flex-wrap gap-1 border-b border-border px-4">
            {PAGES.map((item) => (
              <Button
                aria-current={item.page === page ? 'page' : undefined}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  item.page === page ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
                key={item.page}
                onClick={() => go(item.page)}
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
            {set.data && page === 'scheduling' ? <SchedulingPage advancedScheduling={advancedScheduling} canManage={canManage} set={set.data} /> : null}
            {set.data && page === 'new-draft' ? <NewDraftPage canManage={canManage} set={set.data} /> : null}
            {set.data && page === 'writing-assistant' ? <WritingAssistantPage canWrite={canWrite} set={set.data} /> : null}
            <Link className="text-sm underline" href={socialSetHref(socialSet.id)}>
              All settings for {socialSet.name}
            </Link>
            <Link className="text-sm text-muted-foreground underline" href="/workspace/appearance">
              Theme and text direction are in your Appearance settings
            </Link>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
