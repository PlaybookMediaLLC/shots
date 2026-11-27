'use client'

import { useRef, useState } from 'react'
import { PaperclipIcon } from '@phosphor-icons/react/dist/ssr/Paperclip'
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { call } from '@/lib/content-drafts/client'
import { validateVoiceMemo } from '@/lib/write/voice-memo'

const AUDIO_TYPES: Record<string, string> = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
}

function base64Of(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error('This file could not be read.'))
    reader.readAsDataURL(blob)
  })
}

/** Resize an image file to at most 1024px JPEG base64 for inline assistant attachments. */
export async function prepareImageFile(file: File): Promise<{ name: string; data: string }> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height))
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale))
    )
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const data = await base64Of(await canvas.convertToBlob({ quality: 0.85, type: 'image/jpeg' }))
    return { data, name: file.name || 'pasted-image.jpg' }
  } finally {
    bitmap.close()
  }
}

/** Attach an image to the next message, or a voice memo file to transcribe from. */
export function AssistantAttach({
  onImage,
  onTranscript,
}: {
  onImage: (image: { name: string; data: string }) => void
  /** The words of a voice memo, put in the composer to review before sending. */
  onTranscript: (text: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  async function attach(file: File) {
    setBusy(true)
    try {
      if (file.type.startsWith('image/')) {
        onImage(await prepareImageFile(file))
        return
      }
      const extension = file.name.split('.').at(-1)?.toLowerCase() ?? ''
      const mediaType = AUDIO_TYPES[extension] ?? file.type
      if (file.size > 10 * 1024 * 1024) throw new Error('Choose an audio file of at most 10 MB.')
      validateVoiceMemo(new Uint8Array(await file.arrayBuffer()), mediaType)
      const { transcript } = await call<{ transcript: string }>(
        '/api/v1/content-drafts/transcribe',
        { body: { audio: await base64Of(file), mediaType }, method: 'POST' }
      )
      onTranscript(transcript)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That file could not be attached.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,.mp3,.wav,.m4a,.ogg"
        className="hidden"
        aria-label="Attach an image or voice memo file"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void attach(file)
        }}
      />
      <Button
        type="button"
        size={null}
        variant="custom"
        aria-label="Attach an image or voice memo"
        title="Attach an image or voice memo (or paste / drop images)"
        disabled={busy}
        className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground disabled:opacity-40"
        onClick={() => input.current?.click()}
      >
        {busy ? (
          <SpinnerGapIcon className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <PaperclipIcon className="size-3.5" aria-hidden="true" />
        )}
      </Button>
    </>
  )
}
