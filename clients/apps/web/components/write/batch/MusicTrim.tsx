'use client'

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
import { Slider } from '@/components/ui/slider'
import { assetContentUrl } from '@/lib/editor/services'
import {
  audioLength,
  clampStart,
  clock,
  excerptText,
  latestStart,
  TRIM_STEP_MS,
  trimDialog,
} from '@/lib/write/audio-trim'

/**
 * Where a video's music starts. The slider moves a draft; Save selection sends
 * it, and Cancel or closing drops it, so the saved start is what reopening shows.
 */
export function MusicTrim({
  assetId,
  disabled,
  label,
  onSave,
  startMs,
  videoMs,
}: {
  assetId: string
  disabled?: boolean
  /** Which video's music, for the button's name: "music for video 2". */
  label: string
  onSave: (startMs: number) => Promise<unknown>
  startMs: number
  videoMs: number
}) {
  const [state, dispatch] = React.useReducer(trimDialog, { draftMs: null })
  const [trackMs, setTrackMs] = React.useState<number | null>(null)
  const [problem, setProblem] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const audio = React.useRef<HTMLAudioElement>(null)
  const stopAt = React.useRef<number | undefined>(undefined)
  const open = state.draftMs !== null

  React.useEffect(() => {
    if (!open || trackMs !== null) return
    let live = true
    // Its metadata is enough to place the start; the render decodes the track itself.
    void audioLength(assetContentUrl(assetId)).then((length) => {
      if (!live) return
      if (length === null || !Number.isFinite(length))
        setProblem('This browser cannot read the music.')
      else setTrackMs(Math.round(length))
    })
    return () => {
      live = false
    }
  }, [assetId, open, trackMs])

  const stop = () => {
    window.clearTimeout(stopAt.current)
    audio.current?.pause()
  }
  React.useEffect(() => stop, [])
  const close = () => {
    stop()
    dispatch({ type: 'close' })
  }

  const draft = state.draftMs ?? 0
  const latest = trackMs === null ? 0 : latestStart(trackMs, videoMs)
  const play = () => {
    const element = audio.current
    if (!element) return
    stop()
    element.currentTime = draft / 1000
    void element.play().catch(() => toast.error('This browser could not play the music.'))
    stopAt.current = window.setTimeout(stop, videoMs)
  }
  const save = async () => {
    if (trackMs === null) return
    setSaving(true)
    try {
      // The batch reports a failed save itself and answers false; the draft then stays open.
      if ((await onSave(clampStart(draft, trackMs, videoMs))) === false) return
      close()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The start could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button
        aria-label={`Trim ${label}`}
        disabled={disabled}
        size="sm"
        type="button"
        variant="ghost"
        onClick={() => dispatch({ committedMs: startMs, type: 'open' })}
      >
        Trim{startMs ? ` (from ${clock(startMs)})` : ''}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Trim music</DialogTitle>
            <DialogDescription>
              Choose where the music starts. The video plays {clock(videoMs)} of it.
            </DialogDescription>
          </DialogHeader>
          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : trackMs === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              Reading the track…
            </p>
          ) : (
            <div className="grid gap-3">
              <Slider
                aria-label="Music start"
                aria-valuetext={clock(draft)}
                disabled={latest === 0}
                max={latest}
                min={0}
                step={TRIM_STEP_MS}
                value={[draft]}
                onValueChange={([ms]) => dispatch({ ms: ms ?? 0, trackMs, type: 'move', videoMs })}
              />
              <p className="text-sm" data-testid="trim-excerpt">
                {excerptText(draft, trackMs, videoMs)}
              </p>
              <audio ref={audio} preload="auto" src={assetContentUrl(assetId)} />
              <Button
                className="justify-self-start"
                size="sm"
                type="button"
                variant="outline"
                onClick={play}
              >
                Play selection
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button disabled={trackMs === null || saving} type="button" onClick={() => void save()}>
              Save selection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
