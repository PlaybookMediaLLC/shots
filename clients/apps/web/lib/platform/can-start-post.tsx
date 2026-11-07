'use client'

import * as React from 'react'

const EditorAccess = React.createContext({
  canEdit: false,
  canPublish: false,
  canStartPost: false,
})

/** What this member may do from the editor beneath it, decided on the server. */
export const EditorAccessProvider = EditorAccess.Provider

/** The server still checks every draft; this only decides whether to offer one. */
export function useCanStartPost(): boolean {
  return React.useContext(EditorAccess).canStartPost
}

/**
 * Whether this member may schedule or publish what the editor makes. The
 * schedule route checks `publish:manage` again; this only decides whether to
 * offer the action or explain that someone else has to take it.
 */
export function useCanPublish(): boolean {
  return React.useContext(EditorAccess).canPublish
}

/** Whether designs can be saved to the workspace for this member. */
export function useCanSaveProjects(): boolean {
  return React.useContext(EditorAccess).canEdit
}
