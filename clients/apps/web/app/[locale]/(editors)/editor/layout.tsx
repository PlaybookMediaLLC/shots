import type { ReactNode } from 'react'

/**
 * The screenshot editor's own segment, which holds the publishing workspace.
 *
 * `publish` intercepts a draft opened from the editor (`/publish/<id>`) and
 * shows it over the design, which the editors layout keeps mounted. The slot
 * lives here rather than in that layout so only a navigation *from* the editor
 * is intercepted: Next matches an interception against the address it starts
 * from, and the layout's own segment would match every page of the app.
 *
 * The slot has only `default.tsx` besides the interception: a `page.tsx` for
 * `/editor` itself put the dev server into a full-reload loop. Returning to
 * `/editor` softly therefore keeps the slot's last page, and
 * `PublishWorkspace` hides itself away from a draft's address.
 */
export default function EditorLayout({
  children,
  publish,
}: {
  children: ReactNode
  publish: ReactNode
}) {
  return (
    <>
      {children}
      {publish}
    </>
  )
}
