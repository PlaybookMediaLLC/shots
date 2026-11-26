'use client'

import { createContext, useContext, type ReactNode } from 'react'

/**
 * Tracks whether an editor mounted inside React `<Activity>` is currently
 * visible so hidden editors unregister their assistant abilities and page facts.
 */
const EditorActiveContext = createContext(true)

export function EditorActiveProvider({
  active,
  children,
}: {
  active: boolean
  children: ReactNode
}) {
  return <EditorActiveContext value={active}>{children}</EditorActiveContext>
}

/** True when the enclosing editor surface is currently active and visible. */
export function useEditorActive(): boolean {
  return useContext(EditorActiveContext)
}
