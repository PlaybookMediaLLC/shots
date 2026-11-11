// Ported from apps/desktop/src/shared/ui/resource-list/layout.tsx; see dev/import-founder-hub-ui.mjs.
import type { ReactNode } from 'react'

export function ResourceDetailEmpty({ message }: { message: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-muted-foreground text-sm">{message}</p>
    </div>
  )
}
