// Ported from apps/desktop/src/settings/page-title.tsx; see dev/import-founder-hub-ui.mjs.
import type { ReactNode } from 'react'

export function SettingsPageTitle({ title }: { title: ReactNode }) {
  return <h2 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h2>
}
