import { z } from 'zod'

/**
 * What the assistant knows about the page a person is on, on every page:
 * where they are, what the page shows, and the items open on it. The shell
 * fills in the address and title; a page adds facts and items with
 * `useAssistantPage`. It travels to the model as data, never as instructions.
 */

/** One item open on the page, such as the canvas being edited. */
export const pageEntitySchema = z.object({
  /** The kind of item: `canvas`, `artboard`, `project`, `campaign`, `draft`, … */
  type: z.string().trim().min(1).max(40),
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().max(200).optional(),
})

/** Which interactive editing surface is currently active on the page. */
export const assistantSurfaceSchema = z.enum([
  'none',
  'screenshot-editor',
  'store-screenshots',
  'canvas',
  'creative-sets',
  'code-studio',
  'write-composer',
  'tweet-image',
  'campaign',
])

/** Active editing surface kind. */
export type AssistantSurfaceKind = z.infer<typeof assistantSurfaceSchema>

/** The page the assistant is asked from. */
export const pageContextSchema = z.object({
  /** The address without its locale, such as `/canvas/c123`. */
  path: z.string().max(300),
  /** The page's name as its tab shows it. */
  title: z.string().max(200),
  /** The product area: `home`, `create`, `campaigns`, … */
  area: z.string().max(40),
  /** Active editing surface, when inside an editor or studio. */
  surface: assistantSurfaceSchema.optional(),
  /** Currently selected element or text label, when scoped. */
  selection: z.string().max(200).nullable().optional(),
  /** Short statements about what the page shows right now. */
  facts: z.array(z.string().max(300)).max(12).default([]),
  entities: z.array(pageEntitySchema).max(8).default([]),
})

/** The page the assistant is asked from. */
export type PageContext = z.infer<typeof pageContextSchema>
/** One item open on the page. */
export type PageEntity = z.infer<typeof pageEntitySchema>

/**
 * A line of page data: one line, without angle brackets, so a name cannot
 * close the block or pose as a new instruction.
 */
const line = (value: string) => value.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()

/** The page as a block of data for a system prompt. */
export function describePage(page: PageContext): string {
  const parts = [
    `Page: ${line(page.title) || 'Untitled'} (${line(page.path) || '/'}, area: ${line(page.area) || 'unknown'})`,
    ...(page.surface && page.surface !== 'none' ? [`Active surface: ${line(page.surface)}`] : []),
    ...(page.selection ? [`Selected element: ${line(page.selection)}`] : []),
    ...page.entities.map(
      (entity) =>
        `Open ${line(entity.type)}: ${entity.name ? `"${line(entity.name)}" ` : ''}(id ${line(entity.id)})`
    ),
    ...page.facts.map((fact) => `- ${line(fact)}`),
  ]
  return `<page_context>\n${parts.join('\n')}\n</page_context>`
}

/**
 * Longest address the assistant offers: room for a new visual's prefilled
 * request in any script. Percent-encoded, one UTF-16 unit of the 500-unit
 * request takes up to 9 characters (a 3-byte character), so the editor's
 * start address reaches about 4,522.
 */
export const INTERNAL_HREF_MAX = 4_608

/**
 * An address inside this app the assistant may offer, or null. Only a path:
 * no scheme, host, protocol-relative `//`, or backslash trick.
 */
export function internalHref(value: string): string | null {
  const href = value.trim()
  if (href.length > INTERNAL_HREF_MAX || !href.startsWith('/') || href.startsWith('//')) return null
  if (/[\\\s]/.test(href) || /^\/[^/?#]*:/.test(href)) return null
  return href
}

/** Validate a markdown link destination, allowing only safe in-app paths or http(s) URLs. */
export function safeLinkHref(raw: string): { external: boolean; href: string } | null {
  const internal = internalHref(raw)
  if (internal) return { external: false, href: internal }
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return { external: true, href: parsed.toString() }
    }
  } catch {
    return null
  }
  return null
}
