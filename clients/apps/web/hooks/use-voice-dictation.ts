'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { encodePcmWav } from '@/lib/assistant/wav-encoder'
import { call } from '@/lib/content-drafts/client'
import { validateVoiceMemo } from '@/lib/write/voice-memo'

/** Cap live dictation at 3 minutes (~5.7 MB at 16 kHz mono WAV, safely below the 10 MB limit). */
const MAX_DICTATION_SECONDS = 180

type DictationState = 'idle' | 'recording' | 'transcribing'

/** Mix multi-channel AudioBuffer down to mono Float32Array. */
function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels <= 1) return buffer.getChannelData(0)
  const length = buffer.length
  const mixed = new Float32Array(length)
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const channel = buffer.getChannelData(ch)
    for (let i = 0; i < length; i += 1) mixed[i]! += channel[i]! / buffer.numberOfChannels
  }
  return mixed
}

/** Create a 16 kHz AudioContext when supported, falling back to the device default rate. */
function openAudioContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: 16_000 })
  } catch {
    return new AudioContext()
  }
}

/** Convert WAV bytes to base64 off the synchronous JS string path via FileReader. */
function wavToBase64(wav: Uint8Array<ArrayBuffer>): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : '')
    }
    reader.onerror = () => reject(new Error('Could not encode audio recording.'))
    reader.readAsDataURL(new Blob([wav], { type: 'audio/wav' }))
  })
}

/** Decode recorded chunks, encode to 16 kHz mono WAV, release AudioContext immediately, and base64-encode. */
async function decodeAndEncodeWavBase64(blobs: readonly Blob[]): Promise<string> {
  let audioContext: AudioContext | null = null
  let wav: Uint8Array<ArrayBuffer>
  try {
    audioContext = openAudioContext()
    const raw = await new Blob([...blobs], {
      type: blobs[0]?.type || 'audio/webm',
    }).arrayBuffer()
    const decoded = await audioContext.decodeAudioData(raw)
    wav = encodePcmWav(toMono(decoded), decoded.sampleRate)
  } finally {
    await audioContext?.close().catch(() => undefined)
  }
  validateVoiceMemo(wav, 'audio/wav')
  return wavToBase64(wav)
}

/**
 * In-browser microphone dictation that encodes 16 kHz mono WAV and sends it to
 * Shots' existing `/api/v1/content-drafts/transcribe` endpoint, returning text
 * into the composer for human review before sending.
 */
export function useVoiceDictation({
  onTranscript,
}: {
  onTranscript: (text: string) => void
}) {
  const [state, setState] = useState<DictationState>('idle')
  const [seconds, setSeconds] = useState(0)
  const [supported, setSupported] = useState(false)

  // Monotonic session id invalidates stale getUserMedia, recorder, timer, and transcribe callbacks.
  const sessionRef = useRef(0)
  const startingRef = useRef(false)
  const mountedRef = useRef(true)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<number | null>(null)
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript

  useEffect(() => {
    mountedRef.current = true
    setSupported(
      typeof window !== 'undefined' &&
        typeof MediaRecorder !== 'undefined' &&
        Boolean(navigator.mediaDevices?.getUserMedia)
    )
    return () => {
      mountedRef.current = false
    }
  }, [])

  const releaseTracks = useCallback((detachHandlers: boolean) => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    const recorder = recorderRef.current
    if (recorder && detachHandlers) {
      recorder.ondataavailable = null
      recorder.onerror = null
      recorder.onstop = null
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          // Recorder already stopped.
        }
      }
    }
    recorderRef.current = null
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop()
      streamRef.current = null
    }
  }, [])

  useEffect(
    () => () => {
      sessionRef.current += 1
      startingRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
      releaseTracks(true)
    },
    [releaseTracks]
  )

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
  }, [])

  const cancel = useCallback(() => {
    sessionRef.current += 1
    startingRef.current = false
    abortRef.current?.abort()
    abortRef.current = null
    releaseTracks(true)
    if (mountedRef.current) {
      setSeconds(0)
      setState('idle')
    }
  }, [releaseTracks])

  const start = useCallback(async () => {
    if (state !== 'idle' || startingRef.current) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.error('Voice dictation is not supported in this browser.')
      return
    }
    const session = ++sessionRef.current
    startingRef.current = true
    const chunks: Blob[] = []
    setSeconds(0)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (session !== sessionRef.current || !mountedRef.current) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      streamRef.current = stream
      const recorder = new MediaRecorder(stream)
      recorderRef.current = recorder

      recorder.ondataavailable = (event) => {
        if (session === sessionRef.current && event.data.size > 0) chunks.push(event.data)
      }

      recorder.onerror = () => {
        if (session !== sessionRef.current) return
        releaseTracks(true)
        if (mountedRef.current) {
          setSeconds(0)
          setState('idle')
        }
        toast.error('Voice recording failed. Please try again.')
      }

      recorder.onstop = () => {
        if (session !== sessionRef.current) return
        releaseTracks(false)
        if (!mountedRef.current || chunks.length === 0) {
          if (mountedRef.current) {
            setState('idle')
            setSeconds(0)
          }
          return
        }
        const captured = chunks.splice(0, chunks.length)
        const controller = new AbortController()
        abortRef.current = controller
        setState('transcribing')
        void (async () => {
          try {
            const audio = await decodeAndEncodeWavBase64(captured)
            if (session !== sessionRef.current || !mountedRef.current) return
            const { transcript } = await call<{ transcript: string }>(
              '/api/v1/content-drafts/transcribe',
              {
                body: { audio, mediaType: 'audio/wav' },
                method: 'POST',
                signal: controller.signal,
              }
            )
            if (session === sessionRef.current && mountedRef.current && transcript.trim()) {
              onTranscriptRef.current(transcript.trim())
            }
          } catch (error) {
            if (session === sessionRef.current && mountedRef.current && !controller.signal.aborted) {
              toast.error(
                error instanceof Error ? error.message : 'Could not transcribe voice recording.'
              )
            }
          } finally {
            if (abortRef.current === controller) abortRef.current = null
            if (session === sessionRef.current && mountedRef.current) {
              setSeconds(0)
              setState('idle')
            }
          }
        })()
      }

      recorder.start()
      const startedAt = Date.now()
      setState('recording')
      timerRef.current = window.setInterval(() => {
        if (session !== sessionRef.current || !mountedRef.current) return
        const elapsed = Math.min(
          MAX_DICTATION_SECONDS,
          Math.floor((Date.now() - startedAt) / 1_000)
        )
        setSeconds(elapsed)
        if (elapsed >= MAX_DICTATION_SECONDS) stop()
      }, 500)
    } catch (error) {
      if (session !== sessionRef.current) return
      releaseTracks(true)
      if (mountedRef.current) setState('idle')
      toast.error(
        error instanceof Error && error.name === 'NotAllowedError'
          ? 'Microphone access was denied.'
          : 'Could not start voice dictation.'
      )
    } finally {
      if (session === sessionRef.current) startingRef.current = false
    }
  }, [releaseTracks, state, stop])

  return { cancel, seconds, start, state, stop, supported }
}
