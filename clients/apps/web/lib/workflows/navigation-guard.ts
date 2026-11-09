type WorkflowNavigation = EventTarget & { traverseTo: (key: string) => unknown }
type WorkflowNavigateEvent = Event & {
  navigationType: string
  destination: { sameDocument: boolean; key: string }
}

/** Guard same-document Back/Forward and links; unload retains the browser's native prompt. */
export function guardWorkflowNavigation(requestDiscard: (leave: () => void) => void): () => void {
  const url = window.location.href
  const state = window.history.state
  let leaving = false
  const navigation = (window as Window & { navigation?: WorkflowNavigation }).navigation
  const traverse = (event: Event) => {
    const next = event as WorkflowNavigateEvent
    if (
      leaving ||
      next.navigationType !== 'traverse' ||
      !next.destination.sameDocument ||
      !next.cancelable
    )
      return
    next.preventDefault()
    requestDiscard(() => {
      leaving = true
      navigation?.traverseTo(next.destination.key)
    })
  }
  // Older browsers need a same-route entry so Back cannot unmount the editor first.
  if (!navigation) window.history.pushState(state, '', url)
  const unload = (event: BeforeUnloadEvent) => {
    if (leaving) return
    event.preventDefault()
    event.returnValue = ''
  }
  const pop = (event: PopStateEvent) => {
    if (leaving) return
    // Back landed on the same editor entry; re-arm it while the dialog is open.
    event.stopImmediatePropagation()
    window.history.pushState(state, '', url)
    requestDiscard(() => {
      leaving = true
      window.history.go(-2)
    })
  }
  const click = (event: MouseEvent) => {
    if (
      leaving ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (
      !(anchor instanceof HTMLAnchorElement) ||
      anchor.target === '_blank' ||
      anchor.hasAttribute('download')
    )
      return
    const target = new URL(anchor.href)
    const current = new URL(window.location.href)
    // Section jumps keep the editor mounted and must leave its protection armed.
    if (
      target.origin === current.origin &&
      target.pathname === current.pathname &&
      target.search === current.search
    )
      return
    event.preventDefault()
    event.stopPropagation()
    requestDiscard(() => {
      leaving = true
      window.location.assign(anchor.href)
    })
  }
  window.addEventListener('beforeunload', unload)
  if (navigation) navigation.addEventListener('navigate', traverse)
  else window.addEventListener('popstate', pop)
  document.addEventListener('click', click, true)
  return () => {
    window.removeEventListener('beforeunload', unload)
    if (navigation) navigation.removeEventListener('navigate', traverse)
    else {
      window.removeEventListener('popstate', pop)
      if (!leaving && window.location.href === url) window.history.back()
    }
    document.removeEventListener('click', click, true)
  }
}
