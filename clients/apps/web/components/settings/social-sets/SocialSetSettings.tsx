'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { Pill } from '@/components/platform-ui'
import { DeveloperId } from '@/components/settings/DeveloperId'
import {
  SETTINGS_SECTIONS,
  SOCIAL_SET_PAGES,
  type SocialSetPage,
  settingsHref,
  socialSetHref,
} from '@/components/workspace/settings-sections'
import { SettingsRequestError, settingsErrorMessage } from '@/lib/settings/client'
import { cn } from '@/lib/utils'
import { useSocialSet } from './api'
import { GeneralPage } from './GeneralPage'
import { NewDraftPage } from './NewDraftPage'
import { PublicProfilePage } from './PublicProfilePage'
import { SchedulingPage } from './SchedulingPage'
import { WritingAssistantPage } from './WritingAssistantPage'

/** What the signed-in person may do in a set; the backend checks each again. */
export type SetPermissions = {
  /** Change scheduling, defaults, profile, name and accounts (publish:manage). */
  canManage: boolean
  /** Change the Writing Assistant (artifact:edit). */
  canWrite: boolean
  /** Delete a shared set (workspace owner or admin). */
  isAdmin: boolean
}

/**
 * One profile's settings (RFC 024). Each page has its own address, so the
 * set is chosen by its ID in the URL, independent of the page shown.
 */
export function SocialSetSettings({
  id,
  page,
  permissions,
}: {
  id: string
  page: SocialSetPage
  permissions: SetPermissions
}) {
  const query = useSocialSet(id)
  const connected = useSearchParams().get('connected')
  useEffect(() => {
    if (connected) toast.success(`${connected === 'instagram-standalone' ? 'Instagram' : connected} is connected to this profile.`)
  }, [connected])

  const list = SETTINGS_SECTIONS.find((section) => section.id === 'social-sets')!
  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading profile…</p>
  if (query.isError) {
    const missing = query.error instanceof SettingsRequestError && query.error.status === 404
    return (
      <div className="grid gap-3" role="alert">
        <p className="text-sm text-red-700 dark:text-red-300">
          {missing ? 'This profile does not exist, or it is private to someone else.' : settingsErrorMessage(query.error)}
        </p>
        <Link className="text-sm underline" href={settingsHref(list)}>
          Back to profiles
        </Link>
      </div>
    )
  }
  const set = query.data
  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <Link className="w-fit text-sm text-muted-foreground hover:text-foreground" href={settingsHref(list)}>
          ← All profiles
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden className="size-4 rounded-full" style={{ backgroundColor: set.color }} />
          <h2 className="text-base font-medium text-foreground">{set.name}</h2>
          <Pill tone={set.visibility === 'PRIVATE' ? 'purple' : 'gray'}>
            {set.visibility === 'PRIVATE' ? 'Private to you' : 'Shared with workspace'}
          </Pill>
          <DeveloperId id={set.id} label="Profile" />
        </div>
        <nav aria-label={`${set.name} settings`} className="flex flex-wrap gap-1 border-b border-border">
          {SOCIAL_SET_PAGES.map((item) => (
            <Link
              aria-current={item.slug === page ? 'page' : undefined}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                item.slug === page
                  ? 'border-foreground font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
              href={socialSetHref(set.id, item.slug)}
              key={item.slug}
            >
              {item.title}
            </Link>
          ))}
        </nav>
      </div>
      {page === 'general' ? <GeneralPage permissions={permissions} set={set} /> : null}
      {page === 'scheduling' ? <SchedulingPage canManage={permissions.canManage} set={set} /> : null}
      {page === 'new-draft' ? <NewDraftPage canManage={permissions.canManage} set={set} /> : null}
      {page === 'public-profile' ? <PublicProfilePage canManage={permissions.canManage} set={set} /> : null}
      {page === 'writing-assistant' ? <WritingAssistantPage canWrite={permissions.canWrite} set={set} /> : null}
    </div>
  )
}
