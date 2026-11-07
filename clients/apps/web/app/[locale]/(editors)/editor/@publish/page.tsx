/**
 * The editor itself has no publishing workspace open. `default.tsx` covers a
 * full load; this covers a navigation back to `/editor` from the workspace,
 * where Next would otherwise keep the slot's last page on screen.
 */
export default function EditorWithoutPublishWorkspace() {
  return null
}
