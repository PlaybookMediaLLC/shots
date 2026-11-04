'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Combobox } from '@/components/ui/combobox'
import type { ContentBatch } from '@/lib/api/contracts/content-batches'
import { call } from '@/lib/content-drafts/client'

/** Start a batch in a publishing brand and open it. */
export function NewBatchButton({
  sets,
  defaultSetId,
}: {
  sets: { id: string; name: string }[]
  defaultSetId?: string
}) {
  const [title, setTitle] = React.useState(() => `Batch ${new Date().toLocaleDateString()}`)
  const [setId, setSetId] = React.useState(
    defaultSetId && sets.some((set) => set.id === defaultSetId) ? defaultSetId : sets[0]?.id
  )
  const [busy, setBusy] = React.useState(false)
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        void call<ContentBatch>('/api/v1/content-batches', {
          method: 'POST',
          body: { title, socialSetId: setId },
        })
          .then((batch) => window.location.assign(`/publish/batches/${batch.id}`))
          .catch((error: unknown) => {
            toast.error(error instanceof Error ? error.message : 'The batch could not be started.')
            setBusy(false)
          })
      }}
    >
      <Label className="grid gap-1 font-normal">
        Name
        <Input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
      </Label>
      <Label className="grid gap-1 font-normal">
        Publishing brand
        <Combobox
          aria-label="Publishing brand"
          className="w-full"
          onValueChange={setSetId}
          options={sets.map((set) => ({ label: set.name, value: set.id }))}
          searchPlaceholder="Search publishing brands"
          value={setId}
        />
      </Label>
      <Button type="submit" disabled={busy || !title.trim() || !setId}>
        Start a batch
      </Button>
    </form>
  )
}
