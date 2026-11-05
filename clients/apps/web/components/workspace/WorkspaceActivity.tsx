'use client'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { TRPCClientError } from '@trpc/client'
import { LocalTime } from '@/components/drafts/local-time'
import { SidebarLink as Link } from '@/components/platform-shell/SidebarLink'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useEffect, useState, type ReactNode } from 'react'
import { useTRPCClient } from '@/lib/trpc/react'
import { getErrorMessage } from './settings-client'

/**
 * The work a workspace has in flight: projects, releases, campaigns,
 * announcements, and posts.
 *
 * These domains had list procedures with no screen, so a team could
 * create work through the API and then had nowhere to see it. This page
 * is read-only on purpose: creation flows are workflow features with
 * their own RFCs, and a visible list is the smallest step that makes
 * the platform legible.
 */

type TRPC = ReturnType<typeof useTRPCClient>

type Row = { href?: string; id: string; meta: ReactNode; status: string; title: string }

type Section = {
  empty: string
  emptyAction?: { href: string; label: string }
  key: string
  load: (trpc: TRPC) => Promise<Row[]>
  title: string
}

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** What a source's release carries: "2 features · 1 fix · 3 screenshots". */
function releaseContents(release: {
  features?: Array<{ kind: string }>
  screenshotAssetIds?: string[]
}): string {
  const count = (kinds: string[]) =>
    (release.features ?? []).filter((feature) => kinds.includes(feature.kind)).length
  const parts: Array<[number, string]> = [
    [count(['feature', 'improvement']), 'feature'],
    [count(['fix']), 'fix'],
    [count(['other']), 'change'],
    [release.screenshotAssetIds?.length ?? 0, 'screenshot'],
  ]
  return parts
    .filter(([n]) => n > 0)
    .map(([n, noun]) => `${n} ${noun}${n === 1 ? '' : noun === 'fix' ? 'es' : 's'}`)
    .join(' · ')
}

const SECTIONS: Section[] = [
  {
    empty: 'Save a design from the editor as a project to see it here.',
    key: 'projects',
    load: async (trpc) => {
      const { items } = await trpc.project.list.query({ limit: 5, sort: 'updated' })
      return items.map((project) => ({
        href: `/?project=${encodeURIComponent(project.id)}`,
        id: project.id,
        meta: (
          <>
            Screenshot · Workspace · Edited <LocalTime value={project.updatedAt} />
          </>
        ),
        status: 'Saved to workspace',
        title: project.name,
      }))
    },
    title: 'Recently edited projects',
  },
  {
    empty: 'Releases arrive from a connected repository or the API.',
    emptyAction: { href: '/workflows?view=sources', label: 'Connect a release source' },
    key: 'releases',
    load: async (trpc) => {
      const { releases } = await trpc.release.list.query()
      return releases.map((release) => ({
        href: `/releases/${encodeURIComponent(release.id)}`,
        id: release.id,
        meta: (
          <>
            Updated <LocalTime value={release.updatedAt} />
            {releaseContents(release) ? ` · ${releaseContents(release)}` : null}
          </>
        ),
        status: release.status,
        title: release.title,
      }))
    },
    title: 'Releases',
  },
  {
    empty: 'Start a campaign from a product or release brief in Campaigns.',
    key: 'campaigns',
    load: async (trpc) => {
      const { campaigns } = await trpc.campaign.list.query()
      return campaigns.map((campaign) => ({
        href: `/campaigns/${encodeURIComponent(campaign.id)}`,
        id: campaign.id,
        meta: (
          <>
            {truncate(campaign.objective)} · <LocalTime value={campaign.createdAt} />
          </>
        ),
        status: campaign.status,
        title: campaign.name,
      }))
    },
    title: 'Campaigns',
  },
  {
    empty: 'Announcements are scheduled through the API.',
    key: 'announcements',
    load: async (trpc) => {
      const { announcements } = await trpc.announcement.list.query()
      return announcements.map((announcement) => ({
        id: announcement.id,
        meta: (
          <>
            {announcement._count.recipients} recipients ·{' '}
            <LocalTime value={announcement.scheduledFor ?? announcement.createdAt} />
          </>
        ),
        status: announcement.status,
        title: announcement.releaseDocument?.release.title ?? 'Announcement',
      }))
    },
    title: 'Announcements',
  },
  {
    empty: 'Write and schedule a post in Publish once a channel is connected.',
    key: 'scheduled-posts',
    load: async (trpc) => {
      const { scheduledPosts } = await trpc.scheduledPost.list.query()
      return scheduledPosts.map((post) => ({
        // A campaign variant's post has no draft to open.
        href: post.contentDraftId
          ? `/publish/${encodeURIComponent(post.contentDraftId)}`
          : undefined,
        id: post.id,
        meta: (
          <>
            {post.channelConnection.platform} · <LocalTime value={post.scheduledFor} />
          </>
        ),
        status: post.status,
        title: truncate(post.caption),
      }))
    },
    title: 'Posts',
  },
]

type SectionState = { error: string | null; forbidden: boolean; rows: Row[] | null }

function ActivitySection({ section }: { section: Section }) {
  const trpcClient = useTRPCClient()
  const [limit, setLimit] = useState(5)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<SectionState>({ error: null, forbidden: false, rows: null })

  useEffect(() => {
    let active = true
    section
      .load(trpcClient)
      .then((rows) => active && setState({ error: null, forbidden: false, rows }))
      .catch((error: unknown) => {
        if (!active) return
        const forbidden = error instanceof TRPCClientError && error.data?.code === 'FORBIDDEN'
        setState({ error: getErrorMessage(error), forbidden, rows: null })
      })
    return () => {
      active = false
    }
  }, [section, trpcClient, attempt])

  return (
    <section>
      <h2 className="text-base font-semibold">{section.title}</h2>
      <div className="mt-3">
        {state.rows === null && state.error === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : state.forbidden ? (
          <p className="text-sm text-muted-foreground">
            Your role does not have access to {section.title.toLowerCase()}.
          </p>
        ) : state.error ? (
          <div role="alert">
            <p className="text-sm text-destructive">{state.error}</p>
            <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </Button>
          </div>
        ) : state.rows && state.rows.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6">
            <p className="text-sm text-muted-foreground">Nothing here yet. {section.empty}</p>
            {section.emptyAction ? (
              <Button asChild className="mt-3" size="sm" variant="outline">
                <Link href={section.emptyAction.href}>{section.emptyAction.label}</Link>
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {state.rows?.slice(0, limit).map((row) => (
              <li
                className="relative flex items-center justify-between gap-4 p-4 hover:bg-muted/30"
                key={row.id}
              >
                <div className="min-w-0">
                  {row.href ? (
                    <Link
                      className="block truncate text-sm font-medium hover:underline after:absolute after:inset-0"
                      href={row.href}
                    >
                      {row.title}
                    </Link>
                  ) : (
                    <p className="truncate text-sm font-medium">{row.title}</p>
                  )}
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{row.meta}</p>
                </div>
                <span className="shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                  {row.status}
                </span>
              </li>
            ))}
          </ul>
        )}
        {state.rows && state.rows.length > limit ? (
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            onClick={() => setLimit((value) => value + 10)}
          >
            Show more {section.title.toLowerCase()}
          </Button>
        ) : null}
      </div>
    </section>
  )
}

export function WorkspaceActivity({ sections }: { sections?: string[] } = {}) {
  const [filter, setFilter] = useState('all')
  const visible = SECTIONS.filter(
    (section) =>
      (!sections || sections.includes(section.key)) && (filter === 'all' || filter === section.key)
  )
  return (
    <div className="space-y-10">
      {!sections ? (
        <Label className="grid max-w-xs gap-2 text-sm">
          Activity type
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger
              aria-label="Activity type"
              className="h-10 w-full rounded-lg bg-background"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All activity</SelectItem>
              {SECTIONS.map((section) => (
                <SelectItem key={section.key} value={section.key}>
                  {section.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
      ) : null}
      {visible.map((section) => (
        <ActivitySection key={section.key} section={section} />
      ))}
    </div>
  )
}
