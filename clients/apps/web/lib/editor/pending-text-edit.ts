let pendingId: string | null = null

/** Ask the text layer `id` to open for typing once it appears on the canvas. */
export function requestTextEdit(id: string): void {
  pendingId = id
}

/** Whether a new text layer should open for typing; the request is used once. */
export function takeTextEdit(id: string): boolean {
  if (pendingId !== id) return false
  pendingId = null
  return true
}
