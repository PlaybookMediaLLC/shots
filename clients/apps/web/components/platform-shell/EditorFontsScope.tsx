import '@/app/editor-fonts.css'
import type { ReactNode } from 'react'
import { editorFontVariables } from '@/lib/typography/editor-fonts'
import { EditorFontsPortalBridge } from './EditorFontsPortalBridge'

/**
 * Provides the 23 decorative Google Fonts and SF Pro Display WOFF2 faces only
 * to routes that edit or render visual designs. Uses `display: contents` so it
 * never introduces an extra layout box, and mirrors the variable classes onto
 * `<html>` on the client so Radix portals mounted on `document.body` inherit them.
 */
export function EditorFontsScope({ children }: { children: ReactNode }) {
  return (
    <div className={`${editorFontVariables} contents`}>
      <EditorFontsPortalBridge className={editorFontVariables} />
      {children}
    </div>
  )
}
