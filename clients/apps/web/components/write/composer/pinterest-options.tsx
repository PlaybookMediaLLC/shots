'use client'

import * as React from 'react'
import type { PinterestOptions as Options } from 'screenshot-studio-backend-sdk'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { listPinterestBoardsContract } from '@/lib/api/contracts/social-communities'
import { writeApi } from '@/lib/write/client'

type Boards =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; boards: { id: string; name: string }[] }

/**
 * A pin's board, title and link. The boards are the set's Pinterest
 * account's own; Go requires one when the pin is scheduled.
 */
export function PinterestOptions({
  disabled,
  onChange,
  setId,
  value,
}: {
  disabled: boolean
  onChange: (value: Options | undefined) => void
  setId: string | null
  value: Options | undefined
}) {
  const options = value ?? {}
  const change = (next: Partial<Options>) => onChange({ ...options, ...next })
  const [boards, setBoards] = React.useState<Boards>({ status: 'loading' })
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    if (!setId) return
    let current = true
    setBoards({ status: 'loading' })
    writeApi
      .pinterestBoards(setId)
      .then((page) => listPinterestBoardsContract.output.parse(page))
      .then(
        (page) => current && setBoards({ status: 'ready', boards: page.items }),
        (error: unknown) =>
          current &&
          setBoards({
            status: 'error',
            message:
              error instanceof Error ? error.message : 'The Pinterest boards could not be loaded.',
          })
      )
    return () => {
      current = false
    }
  }, [attempt, setId])
  const missing =
    boards.status === 'ready' &&
    Boolean(options.boardId) &&
    !boards.boards.some((board) => board.id === options.boardId)
  return (
    <div
      className="grid w-full divide-y divide-[var(--divider,var(--border))] text-ui text-muted-foreground [&>*]:px-4 [&>*]:py-2.5 [&_label]:text-ui-lg [&_label]:font-medium [&_label]:text-foreground"
      data-option-rows
      data-testid="pinterest-options"
    >
      <div className="grid gap-2">
        <Label htmlFor="pinterest-board">Board</Label>
        {!setId ? (
          <p>Choose a social set with a Pinterest account to pick a board.</p>
        ) : boards.status === 'loading' ? (
          <p>Loading boards…</p>
        ) : boards.status === 'error' ? (
          <div className="grid justify-items-start gap-2" role="alert">
            <p className="text-destructive">{boards.message}</p>
            <Button onClick={() => setAttempt((count) => count + 1)} size="sm" variant="outline">
              Try again
            </Button>
          </div>
        ) : boards.boards.length === 0 ? (
          <div className="grid justify-items-start gap-2">
            <p>This Pinterest account has no boards. Create one on Pinterest, then try again.</p>
            <Button onClick={() => setAttempt((count) => count + 1)} size="sm" variant="outline">
              Try again
            </Button>
          </div>
        ) : (
          <>
            <Select
              disabled={disabled}
              onValueChange={(boardId) => change({ boardId })}
              value={missing ? undefined : options.boardId}
            >
              <SelectTrigger
                aria-label="Pinterest board"
                data-option-missing={!options.boardId || missing || undefined}
                id="pinterest-board"
              >
                <SelectValue placeholder="Choose a board" />
              </SelectTrigger>
              <SelectContent>
                {boards.boards.map((board) => (
                  <SelectItem key={board.id} value={board.id}>
                    {board.name || board.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {missing ? (
              <p className="text-destructive">
                The chosen board is no longer on this Pinterest account. Choose another.
              </p>
            ) : null}
          </>
        )}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="pinterest-title">Pin title</Label>
        <Input
          disabled={disabled}
          id="pinterest-title"
          maxLength={100}
          onChange={(event) => change({ title: event.target.value || undefined })}
          placeholder="Optional, up to 100 characters"
          value={options.title ?? ''}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="pinterest-link">Link</Label>
        <Input
          disabled={disabled}
          id="pinterest-link"
          inputMode="url"
          maxLength={2048}
          onChange={(event) => change({ link: event.target.value || undefined })}
          placeholder="https://"
          value={options.link ?? ''}
        />
        <p>Where the pin leads when someone opens it.</p>
      </div>
    </div>
  )
}
