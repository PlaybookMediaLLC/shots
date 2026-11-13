'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTRPCClient } from '@/lib/trpc/react'
import { captionAssistant } from '@/lib/write/caption-assistant'

/**
 * Ideas for a UGC video's text from a product description. Choosing one
 * replaces the video's text, not the post's caption. A failure keeps the
 * description to try again, and an answer that arrives after Cancel is dropped.
 */
export function CaptionAssistant({
  disabled,
  label,
  onChoose,
}: {
  disabled?: boolean
  /** Which video, for the button's name: "text for video 2". */
  label: string
  onChoose: (text: string) => void
}) {
  const trpc = useTRPCClient()
  const [state, dispatch] = React.useReducer(captionAssistant, { phase: 'closed' })
  const [description, setDescription] = React.useState('')
  const requests = React.useRef(0)
  const ask = () => {
    const request = ++requests.current
    dispatch({ request, type: 'request' })
    trpc.editorAi.suggestOverlayIdeas.mutate({ description: description.trim() }).then(
      ({ lines }) => dispatch({ choices: lines, request, type: 'answered' }),
      (error: unknown) =>
        dispatch({
          error: error instanceof Error ? error.message : 'No ideas came back. Try again.',
          request,
          type: 'failed',
        })
    )
  }
  const close = () => dispatch({ type: 'close' })
  const failed = state.phase === 'describe' ? state.error : undefined

  return (
    <>
      <Button
        aria-label={`Write ${label} with AI`}
        disabled={disabled}
        size="sm"
        type="button"
        variant="ghost"
        onClick={() => dispatch({ type: 'open' })}
      >
        Write with AI
      </Button>
      <Dialog open={state.phase !== 'closed'} onOpenChange={(open) => (open ? undefined : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ideas for the video’s text</DialogTitle>
            <DialogDescription>
              Describe the product or topic. Choosing an idea replaces the text on the video, not
              the post’s caption.
            </DialogDescription>
          </DialogHeader>
          {state.phase === 'choices' ? (
            <ul aria-label="Ideas" className="grid gap-2">
              {state.choices.map((choice) => (
                <li key={choice}>
                  <Button
                    className="h-auto w-full justify-start whitespace-pre-wrap py-2 text-left"
                    type="button"
                    variant="outline"
                    onClick={() => {
                      onChoose(choice)
                      close()
                    }}
                  >
                    {choice}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="grid gap-2">
              <Label className="grid gap-1.5 font-normal">
                Product or topic
                <Textarea
                  disabled={state.phase === 'requesting'}
                  maxLength={500}
                  rows={3}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Label>
              {failed ? (
                <p role="alert" className="text-sm text-destructive">
                  {failed}
                </p>
              ) : null}
              {state.phase === 'requesting' ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Writing ideas…
                </p>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={!description.trim() || state.phase === 'requesting'}
              type="button"
              onClick={ask}
            >
              {state.phase === 'choices' || failed ? 'Try again' : 'Generate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
