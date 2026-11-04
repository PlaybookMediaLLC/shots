'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { runChecks, type ComplianceIssue } from '@/lib/store-screenshots/compliance'
import { loadExportSettings } from '@/lib/store-screenshots/export/settings'
import { evaluateSlide } from '@/lib/store-screenshots/engine/scene'
import { localeName } from '@/lib/store-screenshots/locales'
import { getStoreTarget, STORE_TARGET_CATALOG_VERSION, targetPixelSize } from '@/lib/store-screenshots/targets'
import { useRenderServices } from '../../render/RenderProvider'
import { useEditor, useEditorApi } from '../editor-store'
import type { DialogProps } from './BasicDialogs'

/**
 * Store requirements and design suggestions for the planned export, each
 * linked to the slide, layer, size, and language it concerns.
 */
export function ChecksDialog({ open, onOpenChange, onExport }: DialogProps & { onExport: () => void }): React.JSX.Element {
  const api = useEditorApi()
  const document = useEditor((state) => state.document)
  const { measurer, fontsVersion } = useRenderServices()
  const selection = React.useMemo(() => loadExportSettings(document), [document])
  const issues = React.useMemo(
    () =>
      runChecks(document, selection, (index, target, sizeIndex, orientation, locale) =>
        evaluateSlide(document, index, { size: targetPixelSize(target, sizeIndex, orientation), targetId: target.id, locale, measurer })
      ),
    // Font readiness changes geometry without changing the measurer function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [document, selection, measurer, fontsVersion]
  )

  const go = (issue: ComplianceIssue) => {
    const state = api.getState()
    if (issue.targetId) state.setTarget(issue.targetId)
    if (issue.locale) state.setLocale(issue.locale)
    if (issue.slideId) state.activateSlide(issue.slideId)
    if (issue.slideId && issue.layerId) state.selectLayers({ kind: 'slide', id: issue.slideId }, [issue.layerId], 'replace', { deep: true })
    onOpenChange(false)
  }

  const groups = [
    { severity: 'requirement' as const, title: 'Store requirements', hint: 'From the published App Store Connect and Google Play rules. Fix these before submitting.' },
    { severity: 'recommendation' as const, title: 'Design suggestions', hint: 'Advice about legibility and layout. These are not store rules.' },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[88vh] sm:max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Checks</DialogTitle>
          <DialogDescription>
            Checking the planned export: {selection.slideIds.length} {selection.slideIds.length === 1 ? 'slide' : 'slides'} for {selection.targets.map((choice) => getStoreTarget(choice.targetId)?.shortName).join(', ')} in {selection.locales.map(localeName).join(', ')}. Change sizes, languages, or slides in Export settings. Store rules as of {STORE_TARGET_CATALOG_VERSION}. Passing these checks does not guarantee approval.
          </DialogDescription>
        </DialogHeader>
        {groups.map((group) => {
          const items = issues.filter((issue) => issue.severity === group.severity)
          return (
            <section key={group.severity} aria-labelledby={`checks-${group.severity}`} className="space-y-2">
              <h3 id={`checks-${group.severity}`} className="text-ui-lg font-semibold">
                {group.title} <span className="font-normal text-muted-foreground">({items.length})</span>
              </h3>
              <p className="text-xs text-muted-foreground">{group.hint}</p>
              {items.length === 0 ? (
                <p className="text-xs text-emerald-700 dark:text-emerald-300">Nothing to fix.</p>
              ) : (
                <ul className="space-y-1.5">
                  {items.map((issue) => {
                    const slideNumber = issue.slideId ? document.slides.findIndex((slide) => slide.id === issue.slideId) + 1 : null
                    return (
                      <li key={issue.id} className="flex items-start gap-2 rounded-md border border-foreground/10 p-2 text-xs">
                        <span className="min-w-0 flex-1">
                          <span className="block">{issue.message}</span>
                          <span className="block text-[10px] text-muted-foreground">
                            {[slideNumber ? `Slide ${slideNumber}` : null, issue.targetId ? getStoreTarget(issue.targetId)?.shortName : null, issue.locale ? localeName(issue.locale) : null].filter(Boolean).join(' · ')}
                            {issue.source ? (
                              <>
                                {' · '}
                                <a href={issue.source} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                                  Store rule
                                </a>
                              </>
                            ) : null}
                          </span>
                        </span>
                        {issue.slideId ? (
                          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => go(issue)}>
                            Show
                          </Button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={onExport}>Export settings…</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
