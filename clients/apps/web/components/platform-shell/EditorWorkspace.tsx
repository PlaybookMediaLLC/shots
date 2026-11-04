'use client'

import { Activity, Suspense, useState } from 'react'
import dynamic from 'next/dynamic'
import { usePathname } from 'next/navigation'
import { EditorLayout } from '@/components/editor/EditorLayout'
import { StoreWorkspaceLoading } from '@/components/store-screenshots/StoreWorkspaceLoading'
import { STORE_SCREENSHOTS } from '@/lib/platform/navigation'
import { withoutLocale } from '@/lib/settings/appearance'

const StoreStudio = dynamic(
  () =>
    import('@/components/store-screenshots/studio/StoreStudio').then(
      (module) => module.StoreStudio
    ),
  {
    ssr: false,
    loading: () => <StoreWorkspaceLoading variant="templates" />,
  }
)

/** A malformed escape in a hand-edited URL names no project instead of throwing. */
function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return ''
  }
}

function Workspace() {
  const pathname = usePathname()
  const path = withoutLocale(pathname)
  const appStore = path === STORE_SCREENSHOTS.href || path.startsWith(`${STORE_SCREENSHOTS.href}/`)
  // `/fr/create/store/<id>` keeps its locale prefix when the studio writes its URL.
  const basePath = `${pathname.slice(0, pathname.length - path.length)}${STORE_SCREENSHOTS.href}`
  const projectId = appStore ? decodeSegment(path.slice(STORE_SCREENSHOTS.href.length + 1)) : ''
  const [visitedStore, setVisitedStore] = useState(appStore)
  if (appStore && !visitedStore) setVisitedStore(true)
  return (
    <>
      <Activity mode={appStore ? 'hidden' : 'visible'}>
        <EditorLayout />
      </Activity>
      <Activity mode={appStore ? 'visible' : 'hidden'}>
        {visitedStore ? (
          <StoreStudio basePath={basePath} projectId={projectId || undefined} />
        ) : null}
      </Activity>
    </>
  )
}

/** Retain documents, selection and history; hidden editors release their global listeners. */
export function EditorWorkspace() {
  return (
    <Suspense fallback={<StoreWorkspaceLoading variant="templates" />}>
      <Workspace />
    </Suspense>
  )
}
