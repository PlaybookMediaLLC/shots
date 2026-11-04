import { createPlatePlugin } from '@shots/platejs-editor/platejs/react'
import { withoutLegacy } from '@/lib/write/legacy-blocks'

/**
 * Pasted rich text keeps what a post can carry (bold, italic, links, lists)
 * and loses the rest (headings, colors, fonts, callouts), as Convert to text
 * does for older drafts.
 */
export const PlainPastePlugin = createPlatePlugin({ key: 'plain_paste' }).overrideEditor(
  ({ tf: { insertFragment } }) => ({
    transforms: {
      insertFragment(fragment, options) {
        insertFragment(withoutLegacy(fragment), options)
      },
    },
  })
)
