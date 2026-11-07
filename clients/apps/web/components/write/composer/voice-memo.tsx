'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { Textarea } from '@/components/ui/textarea'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { call } from '@/lib/content-drafts/client'
import { validateVoiceMemo } from '@/lib/write/voice-memo'
import type { DraftChannel } from '@/lib/write/document'

/**
 * A voice memo becomes editable source material: the reviewed transcript
 * either briefs the assistant or, when the caller takes one, becomes caption
 * copy in the draft directly, so a spoken explanation of a change can be
 * edited as a post without a model rewriting it first.
 */
export function VoiceMemo({draftId,channel,onInsert,onUse}: {draftId:string;channel:DraftChannel;onInsert?:(text:string)=>void;onUse:(text:string)=>void}) {
  const [file,setFile] = useState<File | null>(null)
  const [transcript,setTranscript] = useState('')
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  async function transcribe() {
    if (!file || busy) return
    setBusy(true);setError('')
    try {
      if(file.size > 10 * 1024 * 1024) throw new Error('Choose an audio file of at most 10 MB.')
      const extension = file.name.split('.').at(-1)?.toLowerCase()
      const mediaType = ({mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',ogg:'audio/ogg'} as Record<string,string>)[extension ?? ''] ?? file.type
      validateVoiceMemo(new Uint8Array(await file.arrayBuffer()),mediaType)
      const audio = await new Promise<string>((resolve,reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = () => reject(new Error('This audio file could not be read.'))
        reader.readAsDataURL(file)
      })
      const result = await call<{transcript:string}>('/api/v1/content-drafts/transcribe',{method:'POST',body:{draftId,channel,mediaType,audio}})
      setTranscript(result.transcript)
    } catch (cause) {setError(cause instanceof Error ? cause.message : 'Transcription failed. Your draft is unchanged.')} finally {setBusy(false)}
  }
  return <Disclosure className="rounded-lg border border-border p-3">
    <DisclosureTrigger>Voice memo</DisclosureTrigger>
    <DisclosureContent>
    <p className="my-2 text-xs text-muted-foreground">Upload up to 10 MB of audio. Transcription uses workspace AI credits. Review the text before sending it to the assistant.</p>
    <FileDropZone accept={{'audio/*':['.mp3','.wav','.m4a','.ogg']}} busy={busy} hint="MP3, WAV, M4A or OGG, up to 10 MB." label="Voice memo audio" maxSize={10 * 1024 * 1024} onFiles={([next]) => {setFile(next ?? null);setTranscript('');setError('')}} onRemove={() => {setFile(null);setTranscript('')}} preview={file ? <span className="truncate text-xs">{file.name}</span> : null} />
    <Button type="button" size="sm" className="mt-2" disabled={!file || busy} onClick={() => void transcribe()}>{busy ? 'Transcribing…' : 'Transcribe audio'}</Button>
    {error && <p role="alert" className="mt-2 text-xs">{error}</p>}
    {transcript && <div className="mt-3 grid gap-2">
      <Textarea aria-label="Review voice transcript" rows={5} maxLength={7_600} value={transcript} onChange={event => setTranscript(event.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!transcript.trim()} onClick={() => onUse(`Help me turn these voice notes into a draft. Use only these facts and ask about anything unclear.\n\n${transcript.trim()}`)}>Use reviewed transcript</Button>
        {onInsert && <Button type="button" size="sm" variant="outline" disabled={!transcript.trim()} onClick={() => onInsert(transcript.trim())}>Add as a post</Button>}
      </div>
    </div>}
    </DisclosureContent>
  </Disclosure>
}
