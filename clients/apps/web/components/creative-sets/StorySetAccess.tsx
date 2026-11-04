'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { useTRPCClient } from '@/lib/trpc/react'
import { exampleStorySet } from '@/lib/creative-sets/example'
import { StorySetFormatPreview } from './StorySetFormatPreview'

/** A useful next step and a static example for workspaces awaiting early access. */
export function StorySetAccess() {
  const client = useTRPCClient()
  const [projects, setProjects] = useState<{ count: number; more: boolean } | null>(null)
  useEffect(() => {
    let active = true
    void client.project.list
      .query({ limit: 3 })
      .then((page) => {
        if (active) setProjects({ count: page.items.length, more: Boolean(page.nextCursor) })
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [client])
  return (
    <section
      aria-labelledby="story-set-access"
      className="space-y-6 rounded-xl border bg-foreground/[0.02] p-5 sm:p-6"
    >
      <div className="max-w-2xl space-y-3">
        <h2 id="story-set-access" className="text-xl font-semibold">
          One benefit. Three connected formats.
        </h2>
        <p className="text-sm text-muted-foreground">
          Turn a product screenshot into a wide launch visual, a square card and a portrait post.
          New Story Sets are available to design partners. Saved sets remain available here.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <Link prefetch={false} href="/contact">
              Request design-partner access
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link prefetch={false} href="/design-partners" target="_blank" rel="noopener noreferrer">
              About the program (opens a new tab)
            </Link>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {projects && projects.count > 0
            ? `You have ${projects.more ? 'at least ' : ''}${projects.count} saved ${projects.count === 1 ? 'project' : 'projects'} you can copy into Story Sets once access is enabled.`
            : 'You can keep working in Projects and copy a saved design into a Story Set once access is enabled.'}{' '}
          <Link prefetch={false} href="/library" className="underline underline-offset-4">
            View Projects
          </Link>
        </p>
      </div>
      <div aria-label="Example Story Set" className="border-t pt-5">
        <p className="platform-eyebrow mb-4">Example · Your team’s work, together</p>
        <div className="max-w-3xl">
          <StorySetFormatPreview setId="example" revision={1} document={exampleStorySet} />
        </div>
      </div>
    </section>
  )
}
