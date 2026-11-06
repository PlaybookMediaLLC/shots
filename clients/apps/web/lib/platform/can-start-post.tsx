'use client'

import * as React from 'react'

const EditorAccess = React.createContext({ canEdit: false, canStartPost: false })

/** What this member may do from the editor beneath it, decided on the server. */
export const EditorAccessProvider = EditorAccess.Provider

/** The server still checks every draft; this only decides whether to offer one. */
export function useCanStartPost(): boolean {
  return React.useContext(EditorAccess).canStartPost
}

/** Whether designs can be saved to the workspace for this member. */
export function useCanSaveProjects(): boolean {
  return React.useContext(EditorAccess).canEdit
}
