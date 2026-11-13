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

/**
 * Their markdown input rules ("# ", "> ", "```", "==") stay off too: they would
 * turn post text into formatting a post cannot carry.
 * shortcut: Plate 53 has no public way to drop a configured plugin's input rules,
 * so this clears its private list; the "markdown typed in a post stays text" e2e fails if that changes.
 */
const NO_INPUT_RULES = { __configuredInputRules: [] } as object

/** Kit plugins without the shortcuts Write owns; extend() keeps their components, rules and options. */
export const QuietShortcutPlugins: EditorKitPlugin[] = [
  ...KIT.filter((plugin) => QUIET.has(plugin.key)).map((plugin) =>
    plugin.extend(() => ({ ...NO_INPUT_RULES, shortcuts: { toggle: null } }))
  ),
  // ⌘⇧↵ opens the publish review. extend() keeps the kit's ⌘↵; configure() would drop it.
  ...ExitBreakKit.map((plugin) => plugin.extend(() => ({ shortcuts: { insertBefore: null } }))),
]
