'use client'

import * as React from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { RenameDialog } from '@/components/canvas-workspace/CanvasLibrary'
import { usePrivateCreativeSurface } from '@/components/creative-sets/use-private-surface'
import { CodeIcon, MoreIcon } from '@/components/platform-shell/icons'
import { EmptyState } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { documentLanguages } from '@/lib/code-studio/document'
import { slideSize } from '@/lib/code-studio/layout'
import { languageLabel } from '@/lib/code-studio/languages'
import { useTRPCClient } from '@/lib/trpc/react'
import { CodeScene } from './CodeScene'

type Item = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['codeProject']['list']['query']>
>['items'][number]

const ALL = 'all'
const CARD_WIDTH = 280

/** A project's first slide, drawn small. */
function Preview({ item }: { item: Item }) {
  if (!item.document)
    return (
      <span className="grid size-full place-items-center text-xs text-muted-foreground">
        Saved by a newer version
      </span>
    )
  const size = slideSize(item.document, 0)
  const scale = Math.min(CARD_WIDTH / size.width, 170 / size.height)
  return (
    <span className="grid size-full place-items-center overflow-hidden" aria-hidden>
      <span style={{ width: size.width * scale, height: size.height * scale }}>
        <span
          style={{ display: 'block', transform: `scale(${scale})`, transformOrigin: 'top left' }}
        >
          <CodeScene document={item.document} slideIndex={0} />
        </span>
      </span>
    </span>
  )
}

/**
 * Library › Code: the workspace's Code Studio projects (RFC 053), searchable
 * by name and filtered by language and source repository.
 */
export function CodeLibrary({ canEdit }: { canEdit: boolean }) {
  usePrivateCreativeSurface()
  const client = useTRPCClient()
  const [items, setItems] = React.useState<Item[]>([])
  const [cursor, setCursor] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState('')
  const [archived, setArchived] = React.useState(false)
  const [language, setLanguage] = React.useState(ALL)
  const [repo, setRepo] = React.useState(ALL)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [refresh, setRefresh] = React.useState(0)
  const [renaming, setRenaming] = React.useState<Item | null>(null)

  React.useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      setLoading(true)
      client.codeProject.list
        .query({ search: search.trim() || undefined, archived, limit: 24 })
        .then(
          (page) => {
            if (!active) return
            setItems(page.items)
            setCursor(page.nextCursor)
            setError(null)
          },
          (failure: unknown) =>
            active &&
            setError(failure instanceof Error ? failure.message : 'Could not load code projects.')
        )
        .finally(() => active && setLoading(false))
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [client, search, archived, refresh])

  const languages = [
    ...new Set(items.flatMap((item) => (item.document ? documentLanguages(item.document) : []))),
  ]
  const repos = [
    ...new Set(
      items.map((item) => item.document?.source?.repo).filter((value): value is string => !!value)
    ),
  ]
  const shown = items.filter(
    (item) =>
      (language === ALL ||
        (item.document && documentLanguages(item.document).includes(language))) &&
      (repo === ALL || item.document?.source?.repo === repo)
  )

  const act = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action()
      toast.success(success)
      setRefresh((value) => value + 1)
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : 'That did not work.')
    }
  }

  return (
    <section className="w-full space-y-6" aria-labelledby="code-library-heading">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="code-library-heading" className="text-xl font-medium tracking-tight">
            Code
          </h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Code images, carousels and videos made in Code Studio. Saved to the workspace.
          </p>
        </div>
        {canEdit ? (
          <Button asChild>
            <Link href="/create/code">New code project</Link>
          </Button>
        ) : null}
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          aria-label="Search code projects"
          placeholder="Search code projects"
          className="w-64"
          value={search}
          maxLength={200}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger aria-label="Language" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All languages</SelectItem>
            {languages.map((item) => (
              <SelectItem key={item} value={item}>
                {languageLabel(item)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {repos.length ? (
          <Select value={repo} onValueChange={setRepo}>
            <SelectTrigger aria-label="Repository" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All repositories</SelectItem>
              {repos.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setArchived(!archived)}
          aria-pressed={archived}
        >
          {archived ? 'Show active' : 'Show archived'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!loading && !shown.length ? (
        <EmptyState
          icon={CodeIcon}
          title={archived ? 'No archived code projects' : 'No code projects yet'}
          description="Turn a snippet, a diff or a pull request into an image, a carousel or a video."
          action={
            canEdit && !archived ? (
              <Button asChild>
                <Link href="/create/code">Open Code Studio</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul
          className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]"
          aria-busy={loading}
        >
          {shown.map((item) => (
            <li key={item.id} className="group relative overflow-hidden rounded-xl border bg-card">
              <Link
                href={`/create/code/${item.id}`}
                className="block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="block h-44 bg-muted/40">
                  <Preview item={item} />
                </span>
                <span className="block border-t px-3 py-2">
                  <span className="block truncate text-sm font-medium">{item.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[
                      item.document
                        ? documentLanguages(item.document).map(languageLabel).join(', ')
                        : null,
                      item.document?.source?.repo,
                      item.document && item.document.slides.length > 1
                        ? `${item.document.slides.length} slides`
                        : null,
                      item.updatedAt.toLocaleDateString(),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </Link>
              {canEdit ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="secondary"
                      size="icon"
                      aria-label={`Actions for ${item.name}`}
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <MoreIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setRenaming(item)}>Rename</DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        act(
                          () => client.codeProject.duplicate.mutate({ projectId: item.id }),
                          'Duplicated'
                        )
                      }
                    >
                      Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        act(
                          () =>
                            client.codeProject.archive.mutate({
                              projectId: item.id,
                              archived: !archived,
                            }),
                          archived ? 'Restored' : 'Archived'
                        )
                      }
                    >
                      {archived ? 'Restore' : 'Archive'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <Button
          variant="outline"
          onClick={async () => {
            const page = await client.codeProject.list.query({
              search: search.trim() || undefined,
              archived,
              cursor,
              limit: 24,
            })
            setItems((current) => [...current, ...page.items])
            setCursor(page.nextCursor)
          }}
        >
          Load more
        </Button>
      ) : null}
      {renaming ? (
        <RenameDialog
          name={renaming.name}
          title="Rename code project"
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            await act(
              () => client.codeProject.rename.mutate({ projectId: renaming.id, name }),
              'Renamed'
            )
            setRenaming(null)
          }}
        />
      ) : null}
    </section>
  )
}
