'use client'

import * as React from 'react'

const CanStartPost = React.createContext(false)

/** Whether this member may write drafts, decided on the server for the editor beneath it. */
export const CanStartPostProvider = CanStartPost.Provider

/** The server still checks every draft; this only decides whether to offer one. */
export function useCanStartPost(): boolean {
  return React.useContext(CanStartPost)
}
