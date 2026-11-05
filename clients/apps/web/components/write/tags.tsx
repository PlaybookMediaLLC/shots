'use client'

import { useWriteRouter } from '@/components/write/write-context'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { tagColorSchema } from '@/lib/api/contracts/draft-tags'
import { type DraftTagWire, writeApi } from '@/lib/write/client'
import { cn } from '@/lib/utils'
import { useWrite } from './write-context'

/** A tag colour's chip classes. */
const CHIPS: Record<DraftTagWire['color'], string> = {
  amber: 'bg-amber-400/15 text-amber-700 dark:text-amber-200',
  blue: 'bg-blue-400/15 text-blue-700 dark:text-blue-200',
  gray: 'bg-foreground/10 text-foreground',
  green: 'bg-emerald-400/15 text-emerald-700 dark:text-emerald-200',
  orange: 'bg-orange-400/15 text-orange-700 dark:text-orange-200',
  pink: 'bg-pink-400/15 text-pink-700 dark:text-pink-200',
  red: 'bg-red-400/15 text-red-700 dark:text-red-200',
  sky: 'bg-sky-400/15 text-sky-700 dark:text-sky-200',
  teal: 'bg-teal-400/15 text-teal-700 dark:text-teal-200',
  violet: 'bg-violet-400/15 text-violet-700 dark:text-violet-200',
}

/** A tag as a small coloured chip. */
export function TagChip({ tag }: { tag: { color: DraftTagWire['color']; name: string } }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] leading-none',
        CHIPS[tag.color]
      )}
    >
      {tag.name}
    </span>
  )
}

/** The set's tags: create with a colour and preview, rename, recolour, delete. Each set has its own. */
export function TagManager({ onClose, setId }: { onClose: () => void; setId: string }) {
  const router = useWriteRouter()
  const { data } = useWrite()
  const [tags, setTags] = React.useState(data.tags)
  const [name, setName] = React.useState('')
  const [color, setColor] = React.useState<DraftTagWire['color']>('sky')
  const [busy, setBusy] = React.useState(false)
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }
  const setName_ = data.sets.find((set) => set.id === setId)?.name ?? 'this set'
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Tags in {setName_}</DialogTitle>
          <DialogDescription>
            Each profile has its own tags. Deleting a tag takes it off its drafts.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
          {tags.length === 0 ? (
            <li className="text-xs text-muted-foreground">No tags yet.</li>
          ) : null}
          {tags.map((tag) => (
            <li className="flex items-center gap-2" key={tag.id}>
              <TagChip tag={tag} />
              <span className="flex-1" />
              <Button
                aria-label={`Delete the ${tag.name} tag`}
                className="text-xs text-muted-foreground hover:text-red-800 dark:hover:text-red-300"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await writeApi.deleteTag(setId, tag.id)
                    setTags((current) => current.filter((item) => item.id !== tag.id))
                  })
                }
                size={null}
                type="button"
                variant="custom"
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
        <fieldset className="grid gap-2 border-t border-border pt-3">
          <legend className="text-sm">Create new tag</legend>
          <Input
            aria-label="Tag name"
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            placeholder="Launch"
            value={name}
          />
          <div className="flex flex-wrap gap-1.5">
            {tagColorSchema.options.map((option) => (
              <Button
                aria-label={`Tag colour ${option}`}
                aria-pressed={color === option}
                className={cn(
                  'rounded-full border px-1 py-0.5',
                  color === option ? 'border-foreground' : 'border-transparent'
                )}
                key={option}
                onClick={() => setColor(option)}
                size={null}
                type="button"
                variant="custom"
              >
                <TagChip tag={{ color: option, name: option }} />
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Preview: <TagChip tag={{ color, name: name.trim() || 'Tag' }} />
          </p>
        </fieldset>
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={busy || !name.trim()}
            onClick={() =>
              void run(async () => {
                const tag = await writeApi.createTag(setId, { color, name: name.trim() })
                setTags((current) => [...current, tag])
                setName('')
              })
            }
            type="button"
          >
            Create tag
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
