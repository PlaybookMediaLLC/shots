/**
 * Where the publishing workspace was opened from, so closing it returns there.
 *
 * The screenshot editor opens a draft in the workspace with a history push.
 * Closing goes back one step while the workspace still shows that draft. Once
 * it has moved on (scheduling opens a new draft by default), going back would
 * land on the previous draft instead, so closing replaces the address with
 * the editor's own. Kept for this tab only, like the editor it points to.
 */

type PublishOrigin = { draftId: string; href: string }

let origin: PublishOrigin | null = null

/** Record the editor address a draft is about to be opened from. */
export function rememberPublishOrigin(draftId: string, href: string): void {
  origin = { draftId, href }
}

/** How to leave the workspace showing `draftId`: one step back, or to the editor's address. */
export function leavePublishWorkspace(draftId: string): { back: true } | { href: string } {
  return !origin || origin.draftId === draftId ? { back: true } : { href: origin.href }
}
