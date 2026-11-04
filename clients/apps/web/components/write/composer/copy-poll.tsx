'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { pollProblems, pollRules, type AccountStanding } from '@/lib/write/capabilities'
import type { DraftChannel, PostPoll } from '@/lib/write/document'
import { PollEditor } from './post-tools'

/** Review adaptations explicitly; copying never truncates choices or changes duration. */
export function CopyPollDialog({
  source,
  poll,
  destinations,
  onPrepare,
  onCopy,
  onClose,
}: {
  source: DraftChannel
  poll: PostPoll
  destinations: { channel: DraftChannel; limits?: AccountStanding['pollLimits'] }[]
  onPrepare: (channel: DraftChannel) => void
  onCopy: (channel: DraftChannel, poll: PostPoll) => boolean
  onClose: () => void
}) {
  const [original] = useState(source)
  const [candidate, setCandidate] = useState(() => structuredClone(poll))
  const supported = destinations.filter(
    (item) => item.channel !== original && pollRules(item.channel, { pollLimits: item.limits })
  )
  const [target, setTarget] = useState<DraftChannel | ''>('')
  const [prepared, setPrepared] = useState(false)
  const limits = supported.find((item) => item.channel === target)?.limits
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Copy poll to another channel</DialogTitle>
          <DialogDescription>
            Options and duration are preserved. Review the destination’s requirements before
            replacing its first poll. Its post text stays in place.
          </DialogDescription>
        </DialogHeader>
        <Label>
          Destination{' '}
          <Select
            disabled={prepared}
            value={target}
            onValueChange={(value) => setTarget(value as DraftChannel)}
          >
            <SelectTrigger aria-label="Poll destination">
              <SelectValue placeholder="Choose a channel" />
            </SelectTrigger>
            <SelectContent>
              {supported.map((item) => (
                <SelectItem key={item.channel} value={item.channel}>{item.channel}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
        {!supported.length && <p>No other connected channel has verified poll support.</p>}
        {target && (
          <>
            <PollEditor
              channel={target}
              standing={{pollLimits: limits}}
              poll={candidate}
              onChange={(next) => next && setCandidate(next)}
            />
            {target !== 'linkedin' && candidate.question && (
              <Button
                variant="outline"
                onClick={() => setCandidate(({ question: _question, ...rest }) => rest)}
              >
                Use the destination post’s text as the question
              </Button>
            )}
            {target !== 'mastodon' && candidate.multiple && (
              <Button
                variant="outline"
                onClick={() => setCandidate((value) => ({ ...value, multiple: false }))}
              >
                Convert to single choice
              </Button>
            )}
            {!prepared ? (
              <Button
                disabled={pollProblems(target, candidate, 0, {pollLimits: limits}).length > 0}
                onClick={() => {
                  onPrepare(target)
                  setPrepared(true)
                }}
              >
                Review destination version
              </Button>
            ) : (
              <Button
                disabled={pollProblems(target, candidate, 0, {pollLimits: limits}).length > 0}
                onClick={() => {
                  if (onCopy(target, candidate)) onClose()
                }}
              >
                Copy poll
              </Button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
