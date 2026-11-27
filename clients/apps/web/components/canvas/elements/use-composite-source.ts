'use client'

import { useEffect, useState, type RefObject } from 'react'
import { domToPng } from 'modern-screenshot'

const captures = new Set<() => Promise<void>>()
const excluded = '[data-element-type="callout"], [data-callout-links], [data-export-exclude], .moveable-control-box'

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
    let running: Promise<void> | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const capture = async () => {
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
      if (dirty && !disposed) await capture()
    }
    const schedule = () => {
      dirty = true
      clearTimeout(timer)
      timer = setTimeout(() => { void capture().catch(() => { if (!disposed) setSource(null) }) }, 100)
    }
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
    captures.add(capture)
    schedule()
    return () => {
      disposed = true
      clearTimeout(timer)
      observer.disconnect()
      canvas.removeEventListener('load', onLoad, true)
      captures.delete(capture)
    }
  }, [enabled, height, ref, width])
  return enabled ? source : null
}
