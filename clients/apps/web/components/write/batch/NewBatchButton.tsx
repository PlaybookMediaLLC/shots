'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Combobox } from '@/components/ui/combobox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { ContentBatch } from '@/lib/api/contracts/content-batches'
import { call } from '@/lib/content-drafts/client'
import { cn } from '@/lib/utils'

/** The kinds of batch; each opens the same batch page, set up for it. */
const TOOLS = [
  {
    description: 'Up to 100 videos, one post each, with captions and times in bulk.',
    label: 'Video upload',
    value: 'videos',
  },
  {
    description: 'Folders of images become posts, or one post per image.',
    label: 'Image posts',
    value: 'images',
  },
  {
    description:
      'Up to 30 six-second vertical videos: a headline above four images, each with a label. For example, “Four dinners that take 20 minutes” above sheet pan vegetables, one-pot pasta, grain bowl and miso soup.',
    label: 'Grid videos',
    value: 'grid',
  },
  {
    description: 'Any mix of photos, videos, PDFs and folders, or the rows of a CSV.',
    label: 'Mixed files or a CSV',
    value: 'mixed',
  },
] as const

/** Two steps: pick a kind of batch, then name it and start it in a profile. */
export function NewBatchButton({
  sets,
  defaultSetId,
}: {
  sets: { id: string; name: string }[]
  defaultSetId?: string
}) {
  const [tool, setTool] = React.useState('')
  // The name follows the kind picked until it is typed over, so a batch in the
  // list says what is in it rather than only when it was started.
  const [title, setTitle] = React.useState('')
  const suggested = tool
    ? `${TOOLS.find((item) => item.value === tool)?.label ?? 'Batch'} · ${new Date().toLocaleDateString()}`
    : ''
  const [setId, setSetId] = React.useState(
    defaultSetId && sets.some((set) => set.id === defaultSetId) ? defaultSetId : sets[0]?.id
  )
  const [busy, setBusy] = React.useState(false)
  const begin = () => {
    setBusy(true)
    void call<ContentBatch>('/api/v1/content-batches', {
      method: 'POST',
      body: { title: title.trim() || suggested, socialSetId: setId },
    })
      .then((batch) =>
        window.location.assign(
          `/publish/batches/${batch.id}${tool === 'mixed' ? '' : `?start=${tool}`}`
        )
      )
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'The batch could not be started.')
        setBusy(false)
      })
  }
  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        begin()
      }}
    >
      <div className="grid gap-2">
        <p className="text-sm font-medium">1. What are you posting?</p>
        <RadioGroup
          aria-label="Batch type"
          className="grid gap-3 sm:grid-cols-2"
          data-testid="bulk-tools"
          disabled={busy}
          onValueChange={setTool}
          value={tool}
        >
          {TOOLS.map((item) => (
            <Label
              className={cn(
                'cursor-pointer items-start gap-3 rounded-xl border border-border p-4 font-normal hover:bg-muted',
                tool === item.value && 'border-primary bg-muted'
              )}
              key={item.value}
            >
              <RadioGroupItem value={item.value} />
              <span className="grid gap-1">
                <span className="font-medium">{item.label}</span>
                <span className="text-xs leading-normal text-muted-foreground">
                  {item.description}
                </span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </div>
      {tool ? (
        <div className="grid gap-2">
          <p className="text-sm font-medium">2. Name it and start</p>
          <div className="flex flex-wrap items-end gap-3">
            <Label className="grid gap-1 font-normal">
              Name
              <Input
                value={title || suggested}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Label>
            <Label className="grid gap-1 font-normal">
              Profile
              <Combobox
                aria-label="Profile"
                className="w-full"
                onValueChange={setSetId}
                options={sets.map((set) => ({ label: set.name, value: set.id }))}
                searchPlaceholder="Search profiles"
                value={setId}
              />
            </Label>
            <Button type="submit" disabled={busy || !(title.trim() || suggested) || !setId}>
              Start a batch
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  )
}
