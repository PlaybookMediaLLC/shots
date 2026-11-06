'use client'

import { ArrowForwardIcon as ArrowRight } from '@/components/platform-shell/icons'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { EmptyState } from '@/components/platform-ui'
import { RecentIcon as Clock3 } from '@/components/platform-shell/icons'
import { PostIcon as FileText } from '@/components/platform-shell/icons'
import { ImageIcon as Image } from '@/components/platform-shell/icons'
import { CanvasIcon as Layers } from '@/components/platform-shell/icons'
import { useQuery } from '@tanstack/react-query'
import { useTRPCClient } from '@/lib/trpc/react'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { Button } from '@/components/ui/button'
import { ProjectPreview } from '@/components/projects/ProjectPreview'
import { Stage, Window } from '@/components/platform-landing/primitives'
import { recentWorkQuery } from './work'

/** Bounded reads from existing tenant-authorized collections; failures stay visible. */
export function RecentWork({
  draftsEnabled,
  organizationId,
  paidPlan = true,
}: {
  draftsEnabled: boolean
  organizationId: string
  /** Without it, screenshots and canvases are a paid feature, so only posts are listed. */
  paidPlan?: boolean
}) {
  const client = useTRPCClient()
  const query = useQuery({
    ...recentWorkQuery(client, organizationId, draftsEnabled, paidPlan),
    // Coming back from an editor shows the last list at once, then adds what was just saved.
    refetchOnMount: 'always',
  })
  return (
    <section aria-label="Continue working" className="home-recent space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-normal tracking-[-0.01em]">Continue working</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Your most recently updated work.</p>
        </div>
        <SidebarLink
          href={paidPlan ? '/library' : '/publish'}
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {paidPlan ? 'View library' : 'View drafts'} <ArrowRight size={14} aria-hidden="true" />
        </SidebarLink>
      </div>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading recent work…
        </p>
      ) : null}
      {query.isError || query.data?.partial ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
        >
          <p>Some recent work could not load.</p>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      {query.data?.items.length ? (
        <ul className="studio-grid">
          {query.data.items.map((item, index) => (
            <li className="studio-shot" key={`${item.type}-${item.id}`}>
              <SidebarLink className="block" href={item.href}>
                <span className="studio-shot-media">
                  {item.type === 'Post' ? (
                    // A post has no picture, so it sits on the landing page's grain stage.
                    <Stage className="size-full rounded-none" variant={index}>
                      <Window className="w-[80%]" meta={item.status ?? "Draft"} title="Post">
                        {item.excerpt ? (
                          <span className="line-clamp-4 block px-4 py-4 text-start text-[14px] leading-relaxed text-white/90">
                            {item.excerpt}
                          </span>
                        ) : (
                          // An empty draft shows the shape of a post rather than a label.
                          <span aria-hidden="true" className="grid gap-2.5 px-4 py-5">
                            <span className="h-2 w-[85%] rounded-full bg-white/15" />
                            <span className="h-2 w-[65%] rounded-full bg-white/10" />
                            <span className="h-2 w-[40%] rounded-full bg-white/10" />
                          </span>
                        )}
                      </Window>
                    </Stage>
                  ) : (
                    <ProjectPreview
                      alt=""
                      className="studio-cover"
                      document={item.document ?? null}
                    />
                  )}
                  <span aria-hidden="true" className="studio-shot-overlay">
                    {item.title}
                  </span>
                </span>
                <span className="studio-shot-meta">
                  <span aria-hidden="true" className="studio-shot-kind">
                    {item.type === 'Post' ? (
                      <FileText size={12} />
                    ) : item.type === 'Canvas' ? (
                      <Layers size={12} />
                    ) : (
                      <Image size={12} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.type} · {item.scope}
                    </span>
                  </span>
                  <time
                    className="shrink-0 text-xs text-muted-foreground"
                    dateTime={item.updatedAt.toISOString()}
                  >
                    {item.updatedAt.toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </time>
                </span>
              </SidebarLink>
            </li>
          ))}
        </ul>
      ) : query.data && !query.data.partial ? (
        <EmptyState
          icon={Clock3}
          title="Your work will appear here"
          description={
            paidPlan
              ? 'Save a screenshot, canvas, or post to keep everything close at hand.'
              : 'Drafts you write in Publish appear here.'
          }
          action={
            <ButtonLink href={paidPlan ? '/create' : '/publish'}>
              {paidPlan ? 'Create your first visual' : 'Write your first post'}
            </ButtonLink>
          }
        />
      ) : null}
      {paidPlan ? (
        <SidebarLink
          href="/library?type=store"
          className="inline-block text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Find store projects saved on this browser
        </SidebarLink>
      ) : null}
    </section>
  )
}
