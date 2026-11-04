import { BasicBlocksKit, BasicMarksKit, CodeBlockKit } from '@shots/platejs-editor/plugins'

/**
 * Plate's document shortcuts Write turns off. Headings, quotes and code blocks
 * cannot publish in a post (old drafts still render them), and ⌘. (new draft),
 * ⌘⇧. (emoji) and ⌘⇧H (display mode) belong to Write, so superscript, the
 * blockquote toggle and highlight no longer fire on the same keys.
 */
const QUIET = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code_block', 'superscript', 'highlight'])

/** The kit's plugins for those keys, unchanged except for their shortcut. */
export const QuietShortcutPlugins = [...BasicBlocksKit, ...BasicMarksKit, ...CodeBlockKit]
  .filter((plugin) => QUIET.has(plugin.key))
  .map((plugin) => plugin.configure({ shortcuts: { toggle: null } }))
