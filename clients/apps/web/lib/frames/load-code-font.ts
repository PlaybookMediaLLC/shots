import type { CodeContent } from '@/lib/frames/schema'
import { loadGoogleFont } from '@/lib/typography/google-fonts'

/** Load a code screen's font; resolves when it can be drawn (or failed and falls back). */
export function loadCodeFont(content: Pick<CodeContent, 'font'>): Promise<void> {
  return loadGoogleFont(content.font, ['normal']).catch(() => undefined)
}
