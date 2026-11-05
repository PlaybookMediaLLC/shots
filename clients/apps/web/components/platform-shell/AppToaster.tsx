'use client'

import { usePathname } from 'next/navigation'
import { Toaster } from '@/components/ui/sonner'
import { platformArea } from '@/lib/platform/navigation'
import { withoutLocale } from '@/lib/settings/appearance'

/**
 * Toasts on the signed-in app pages sit bottom-centre: bottom-left covered the
 * sidebar's account switcher, and the top covered a draft's title and save
 * state. The editors keep the bottom-left their panels were laid out around.
 */
export function AppToaster() {
  const path = withoutLocale(usePathname() ?? '/')
  const area = platformArea(path)
  const app = (area !== undefined && area !== 'create') || path === '/create' || path === '/upgrade'
  return <Toaster position={app ? 'bottom-center' : undefined} />
}
