'use client'
import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { autoDmSchema, type AutoDm } from '@/lib/write/document'

/** Prepare and persist a campaign while making the unavailable delivery state explicit. */
export function AutoDmDraft({
  value,
  onChange,
  readOnly,
}: {
  value?: AutoDm
  onChange: (value: AutoDm | undefined) => void
  readOnly: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState<AutoDm>(
    value ?? { match: 'any', replies: true, reposts: false, requireFollow: false, message: '' }
  )
  const [error, setError] = React.useState('')
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* A trigger, so closing the dialog returns focus to it. */}
      <DialogTrigger asChild>
        <Button
          disabled={readOnly}
          variant="outline"
          size="sm"
          className="h-8 rounded-md text-ui"
          onClick={() => {
            setError('')
            setForm(
              value ?? {
                match: 'any',
                replies: true,
                reposts: false,
                requireFollow: false,
                message: '',
              }
            )
          }}
        >
          Auto-DM settings{value ? ' · prepared' : ''}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Prepare Auto-DM campaign</DialogTitle>
          <DialogDescription>
            Delivery is off. Authorized X messaging and event access, consent records, and opt-out
            processing must be configured before campaigns can run.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            const parsed = autoDmSchema.safeParse(form)
            if (!parsed.success) {
              setError(parsed.error.issues[0].message)
              return
            }
            onChange(parsed.data)
            setOpen(false)
          }}
        >
          <p className="text-xs">
            The first post must explicitly offer a DM. Eligible recipients must opt in to that
            offer. Campaigns last four days; product caps are 30/minute, 100/hour, 500/day, and
            three active campaigns, subject to lower provider limits.
          </p>
          <Label>
            Match
            <Select
              value={form.match}
              onValueChange={(value) => setForm({ ...form, match: value as AutoDm['match'] })}
            >
              <SelectTrigger aria-label="Auto-DM action matching">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any selected action</SelectItem>
                <SelectItem value="all">All selected actions</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          {(['replies', 'reposts', 'requireFollow'] as const).map((key) => (
            <Label key={key} className="flex gap-2">
              <Checkbox
                checked={form[key]}
                onCheckedChange={(checked) =>
                  setForm({
                    ...form,
                    [key]: checked === true,
                    ...(key === 'replies' && checked !== true ? { replyText: '' } : {}),
                  })
                }
              />
              {
                {
                  replies: 'Replied to the first post',
                  reposts: 'Reposted the first post',
                  requireFollow: 'Must also follow this account',
                }[key]
              }
            </Label>
          ))}
          <Label className="block">
            Reply must contain
            <Input
              disabled={!form.replies}
              maxLength={100}
              value={form.replyText ?? ''}
              onChange={(event) => setForm({ ...form, replyText: event.target.value })}
            />
          </Label>
          <Label className="block">
            Direct message
            <Textarea
              maxLength={10_000}
              value={form.message}
              onChange={(event) => setForm({ ...form, message: event.target.value })}
            />
          </Label>
          <p className="text-xs">
            Variables: {'{{first_name}}, {{full_name}}, {{username}}, {{action}}, {{post_url}}'}. An
            opt-out instruction is appended. Following or engaging alone is not consent.
          </p>
          {error ? <p role="alert">{error}</p> : null}
          <DialogFooter>
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                onChange(undefined)
                setOpen(false)
              }}
            >
              Remove settings
            </Button>
            <Button type="submit">Save prepared settings</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
