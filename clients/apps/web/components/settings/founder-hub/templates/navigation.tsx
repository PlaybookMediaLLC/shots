'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'

export type Tab = {
  type: 'templates'
  state: {
    isWebMode?: boolean
    selectedMineId?: string | null
    selectedWebIndex?: number | null
  }
}
const Context = createContext<{
  tab: Tab
  updateTemplatesTabState: (tab: Tab, state: Tab['state']) => void
} | null>(null)

export function TemplateNavigation({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<Tab>({ type: 'templates', state: { selectedMineId: '__auto__' } })
  return (
    <Context.Provider
      value={{ tab, updateTemplatesTabState: (_, state) => setTab({ type: 'templates', state }) }}
    >
      {children}
    </Context.Provider>
  )
}
export function useTabs<T>(
  select: (value: NonNullable<React.ContextType<typeof Context>>) => T
): T {
  const value = useContext(Context)
  if (!value) throw new Error('Templates require their navigation provider.')
  return select(value)
}
