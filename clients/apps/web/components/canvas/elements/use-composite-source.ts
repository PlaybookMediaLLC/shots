'use client'

import { useEffect, useState, type RefObject } from 'react'
import { domToPng } from 'modern-screenshot'
import { usePlaybackStore } from '@/lib/store/playback'

const captures = new Set<() => Promise<void>>()
const excluded = '[data-element-type="callout"], [data-callout-links], [data-export-exclude], .moveable-control-box'
const COMPOSITE_DEBOUNCE_MS = 300

/** Wait for magnifiers to contain the current canvas before capturing an export. */
export async function waitForCompositeSources(): Promise<void> {
  if (captures.size === 0) return
  await Promise.all([...captures].map((capture) => capture()))
  // React must commit the captured source before the export reads the DOM.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

/** A magnifier samples the rendered design, excluding magnifiers themselves. */
export function useCompositeSource(ref: RefObject<HTMLDivElement | null>, width: number, height: number, enabled: boolean) {
  const [source, setSource] = useState<string | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!enabled || !canvas) return
    let disposed = false
    let dirty = true
    let pointerActive = false
    let running: Promise<void> | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const isPaused = () => pointerActive || usePlaybackStore.getState().isPlaying
    const capture = async (force = false) => {
      clearTimeout(timer)
      if (running) await running
      if (disposed || !dirty) return
      dirty = false
      running = domToPng(canvas, {
        width, height, scale: 1,
        fetch: { requestInit: { mode: 'cors', cache: 'no-cache' } },
        style: { transform: 'none' },
        filter: (node) => !(node instanceof Element && node.matches(excluded)),
      }).then((url) => { if (!disposed) setSource(url) }).catch((error) => {
        dirty = true
        throw error
      }).finally(() => { running = null })
      await running
      if (dirty && !disposed && (force || !isPaused())) await capture(force)
    }
    const forceCapture = () => capture(true)
    const schedule = (delay = COMPOSITE_DEBOUNCE_MS) => {
      dirty = true
      clearTimeout(timer)
      if (isPaused()) return
      timer = setTimeout(() => {
        if (!isPaused()) void capture().catch(() => { if (!disposed) setSource(null) })
      }, delay)
    }
    const onPointerDown = () => {
      pointerActive = true
      clearTimeout(timer)
    }
    const onPointerEnd = () => {
      if (!pointerActive) return
      pointerActive = false
      if (dirty && !disposed && !usePlaybackStore.getState().isPlaying) schedule()
    }
    const unsubscribePlayback = usePlaybackStore.subscribe((state, prev) => {
      if (prev.isPlaying && !state.isPlaying && dirty && !disposed && !pointerActive) {
        schedule()
      }
    })
    const observer = new MutationObserver((changes) => {
      if (changes.some((change) => {
        const target = change.target instanceof Element ? change.target : change.target.parentElement
        return !target?.closest(excluded)
      })) schedule()
    })
    observer.observe(canvas, { attributes: true, attributeFilter: ['style', 'src', 'class'], childList: true, characterData: true, subtree: true })
    const onLoad = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest(excluded)) schedule()
    }
    canvas.addEventListener('load', onLoad, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerEnd, true)
    window.addEventListener('pointercancel', onPointerEnd, true)
    window.addEventListener('blur', onPointerEnd)
    window.addEventListener('contextmenu', onPointerEnd, true)
    window.addEventListener('dragstart', onPointerEnd, true)
    captures.add(forceCapture)
    schedule(100)
    return () => {
      disposed = true
      clearTimeout(timer)
      unsubscribePlayback()
      observer.disconnect()
      canvas.removeEventListener('load', onLoad, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerEnd, true)
      window.removeEventListener('pointercancel', onPointerEnd, true)
      window.removeEventListener('blur', onPointerEnd)
      window.removeEventListener('contextmenu', onPointerEnd, true)
      window.removeEventListener('dragstart', onPointerEnd, true)
      captures.delete(forceCapture)
    }
  }, [enabled, height, ref, width])
  return enabled ? source : null
}
