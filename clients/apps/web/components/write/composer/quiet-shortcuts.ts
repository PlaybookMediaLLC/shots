import type { EditorKitPlugin } from '@shots/platejs-editor/components'
import type { AnyPlatePlugin } from '@shots/platejs-editor/platejs/react'
import {
  BasicBlocksKit,
  BasicMarksKit,
  CodeBlockKit,
  ExitBreakKit,
} from '@shots/platejs-editor/plugins'

/**
 * Plate's document shortcuts Write turns off. Headings, quotes and code blocks
 * cannot publish in a post (old drafts still render them), and ⌘. (new draft),
 * ⌘⇧. (emoji) and ⌘⇧H (display mode) belong to Write, so superscript, the
 * blockquote toggle and highlight no longer fire on the same keys.
 */
const QUIET = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code_block', 'superscript', 'highlight'])

// Typed as any plugin: checking calls on a union of the kits' plugin types is costly.
const KIT: AnyPlatePlugin[] = [...BasicBlocksKit, ...BasicMarksKit, ...CodeBlockKit]

/** Kit plugins re-configured without the shortcuts Write owns. */
export const QuietShortcutPlugins: EditorKitPlugin[] = [
  ...KIT.filter((plugin) => QUIET.has(plugin.key)).map((plugin) =>
    plugin.configure({ shortcuts: { toggle: null } })
  ),
  // ⌘⇧↵ opens the publish review. extend() keeps the kit's ⌘↵; configure() would drop it.
  ...ExitBreakKit.map((plugin) => plugin.extend(() => ({ shortcuts: { insertBefore: null } }))),
]
