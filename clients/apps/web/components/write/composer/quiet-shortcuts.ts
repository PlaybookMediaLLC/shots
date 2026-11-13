import type { AnyPlatePlugin } from '@shots/platejs-editor/platejs/react'
import { BasicBlocksKit, BasicMarksKit, CodeBlockKit } from '@shots/platejs-editor/plugins'

/**
 * Plate's document shortcuts Write turns off. Headings, quotes and code blocks
 * cannot publish in a post (old drafts still render them), and ⌘. (new draft),
 * ⌘⇧. (emoji) and ⌘⇧H (display mode) belong to Write, so superscript, the
 * blockquote toggle and highlight no longer fire on the same keys.
 */
const QUIET = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code_block', 'superscript', 'highlight'])

// Typed as any plugin: checking calls on a union of the kits' plugin types is costly.
const KIT: AnyPlatePlugin[] = [...BasicBlocksKit, ...BasicMarksKit, ...CodeBlockKit]

/**
 * Those kit plugins without their shortcut or markdown input rules ("# ", "> ",
 * "```", "==", "^"), which would turn post text into formatting a post cannot
 * carry. extend() keeps their elements and break rules. Old code blocks show
 * unhighlighted: highlighting re-ran on every edit, and "Auto" tried every grammar.
 */
export const QuietShortcutPlugins: AnyPlatePlugin[] = KIT.filter((plugin) =>
  QUIET.has(plugin.key)
).map((plugin) =>
  // shortcut: clears Plate 53's private __configuredInputRules (no public API does); switch
  // when Plate adds one or the "markdown typed in a post stays text" e2e fails.
  plugin.extend(() => ({
    __configuredInputRules: [],
    shortcuts: { toggle: null },
    ...(plugin.key === 'code_block' ? { options: { lowlight: null } } : {}),
  }))
)
