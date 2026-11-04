'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RenderProvider } from '@/components/store-screenshots/render/RenderProvider'
import { ActiveSceneProvider } from '@/components/store-screenshots/studio/active-scene'
import {
  StudioActionsProvider,
  type StudioActions,
  type StudioDialog,
} from '@/components/store-screenshots/studio/actions'
import { EditorCanvas } from '@/components/store-screenshots/studio/canvas/EditorCanvas'
import {
  createEditorStore,
  EditorStoreProvider,
} from '@/components/store-screenshots/studio/editor-store'
import { Filmstrip } from '@/components/store-screenshots/studio/Filmstrip'
import { Inspector } from '@/components/store-screenshots/studio/inspector/Inspector'
import { Sidebar } from '@/components/store-screenshots/studio/sidebar/Sidebar'
import { useEditorShortcuts } from '@/components/store-screenshots/studio/shortcuts'
import { ImportDialog } from '@/components/store-screenshots/studio/dialogs/ImportDialog'
import { StoreSetExport } from './StoreSetExport'
import { StoreMotionDialog } from './StoreMotionDialog'
import { ChecksDialog } from '@/components/store-screenshots/studio/dialogs/ChecksDialog'
import { StorePreviewDialog } from '@/components/store-screenshots/studio/dialogs/StorePreviewDialog'
import {
  ApplyStyleDialog,
  ResetSlideDialog,
  ShortcutsDialog,
} from '@/components/store-screenshots/studio/dialogs/BasicDialogs'
import { StudioFeatureDialogs } from '@/components/store-screenshots/studio/dialogs/FeatureDialogs'
import { addStoreImages, type StoreImageTarget } from './store-images'
import { EMPTY_HISTORY } from '@/lib/store-screenshots/commands/history'
import { applySetCommand } from '@/lib/creative-sets/commands'
import { loadStoreAsset } from '@/lib/creative-sets/store-assets'
import { storeBrandOverrides, resetStoreBrandField } from '@/lib/creative-sets/store-brand'
import type { StoreGroup } from '@/lib/creative-sets/store-schema'
import type { CreativeSetSession } from '@/lib/creative-sets/session'

/** Embed native store tools while the surrounding set owns transactions, history and persistence. */
export function StoreGroupEditor({
  session,
  group,
  canEdit,
  registerFlush,
}: {
  session: CreativeSetSession
  group: StoreGroup
  canEdit: boolean
  registerFlush: (flush: (() => void) | null) => void
}) {
  const [store] = useState(() => {
    const created = createEditorStore(group.document)
    if (!canEdit)
      created.setState({
        dispatch: () => false,
        dispatchMany: () => false,
        replaceDocument: () => undefined,
      })
    return created
  })
  const currentGroup = useRef(group)
  useEffect(() => {
    currentGroup.current = group
  }, [group])
  const document = useStore(store, (state) => state.document)
  const activeSlideId = useStore(store, (state) => state.activeSlideId)
  const [dialog, setDialog] = useState<StudioDialog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [storyId, setStoryId] = useState(session.snapshot().document.stories[0]!.id)
  const input = useRef<HTMLInputElement>(null)
  const target = useRef<StoreImageTarget>({ kind: 'image' })
  const baseline = useRef(group.document)
  const flush = useCallback(() => {
    if (!canEdit) return
    const next = store.getState().document
    if (JSON.stringify(next) === JSON.stringify(baseline.current)) return
    try {
      const changed = applySetCommand(session.snapshot().document, {
        type: 'store-edit',
        groupId: group.id,
        document: next,
      })
      session.commit(changed, false)
      baseline.current = next
      store.setState({ history: EMPTY_HISTORY })
      setError(null)
      session.editorFailure(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The store edit could not be saved.'
      setError(message)
      session.editorFailure(message)
      throw error
    }
  }, [canEdit, group.id, session, store])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let pointing = false
    const safeFlush = () => {
      try {
        flush()
      } catch {
        /* Keep the native edit available for correction. */
      }
    }
    const start = () => {
      safeFlush()
      pointing = true
    }
    const end = () => {
      pointing = false
      clearTimeout(timer)
      timer = setTimeout(safeFlush, 0)
    }
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.document === previous.document) return
      clearTimeout(timer)
      if (!pointing) timer = setTimeout(safeFlush, 500)
    })
    const undo = () => {
        if (canEdit) {
          flush()
          session.undo()
        }
      },
      redo = () => {
        if (canEdit) {
          flush()
          session.redo()
        }
      }
    store.setState({ undo, redo })
    registerFlush(flush)
    window.addEventListener('pointerdown', start, true)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('focusout', end)
    window.addEventListener('blur', end)
    return () => {
      safeFlush()
      clearTimeout(timer)
      unsubscribe()
      registerFlush(null)
      window.removeEventListener('pointerdown', start, true)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('focusout', end)
      window.removeEventListener('blur', end)
    }
  }, [flush, registerFlush, session, store, canEdit])
  async function importFiles(files: File[], device: { slideId: string; layerId: string } | null) {
    if (!canEdit) return
    try {
      await addStoreImages(store, files, device ? { kind: 'device', ...device } : target.current)
      flush()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Image import failed.')
    }
  }
  const actions: StudioActions = {
    chooseScreenshot(device) {
      if (device) {
        target.current = { kind: 'device', ...device }
        input.current?.click()
      } else setDialog('import')
    },
    importFiles: (files, device) => void importFiles(files, device),
    chooseImageLayer() {
      target.current = { kind: 'image' }
      input.current?.click()
    },
    chooseBackgroundImage() {
      target.current = { kind: 'background' }
      input.current?.click()
    },
    openDialog(next) {
      flush()
      if (next === 'publish') {
        if (group.review.source) {
          setError('Review the changed screenshots before publishing.')
          return
        }
        void session.save().then((saved) => {
          if (saved) setDialog(next)
          else setError('Save this set before publishing.')
        })
      } else setDialog(next)
    },
  }
  useEditorShortcuts(store, actions, () => {
    flush()
    void session.save()
  })
  const loadAsset = useCallback(
    (id: string) =>
      loadStoreAsset(
        session.client,
        { ...currentGroup.current, document: store.getState().document },
        id
      ),
    [session, store]
  )
  const close = (open: boolean) => {
    if (!open) {
      flush()
      setDialog(null)
    }
  }
  const command = (value: Parameters<CreativeSetSession['command']>[0]) => {
    flush()
    session.command(value)
  }
  return (
    <EditorStoreProvider value={store}>
      <RenderProvider document={document} loadAsset={loadAsset}>
        <StudioActionsProvider value={actions}>
          <ActiveSceneProvider>
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
                <span className="mr-auto text-ui-lg font-medium">
                  {group.name} · native store layers
                </span>
                {canEdit ? (
                  <>
                    <Select value={storyId} onValueChange={setStoryId}>
                      <SelectTrigger
                        aria-label="Story for selected store slide"
                        size="sm"
                        className="max-w-48 text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {session.snapshot().document.stories.map((story) => (
                          <SelectItem key={story.id} value={story.id}>
                            {story.headline}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        command({
                          type: 'link-store-slide',
                          groupId: group.id,
                          slideId: activeSlideId,
                          storyId,
                        })
                      }
                    >
                      Link slide to story
                    </Button>
                  </>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    flush()
                    setDialog('preview')
                  }}
                >
                  Preview
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  hidden={!canEdit}
                  onClick={() => {
                    flush()
                    setDialog('animation')
                  }}
                >
                  Motion
                </Button>
                <Button
                  size="sm"
                  disabled={group.review.source}
                  onClick={() => {
                    flush()
                    setDialog('export')
                  }}
                >
                  Export store sizes
                </Button>
              </div>
              {group.brandAssignment ? (
                <Disclosure className="border-b p-3 text-xs">
                  <DisclosureTrigger>Brand · linked to the set’s accepted version</DisclosureTrigger>
                  <DisclosureContent>
                    {storeBrandOverrides(group).map((field) => (
                      <div className="mt-2 flex items-center gap-2" key={field.label}>
                        <span>{field.label} · Override in this store group</span>
                        {canEdit ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              flush()
                              const next = structuredClone(session.snapshot().document)
                              const index = next.storeGroups.findIndex((item) => item.id === group.id)
                              next.storeGroups[index] = resetStoreBrandField(
                                next.storeGroups[index]!,
                                field
                              )
                              session.commit(next)
                            }}
                          >
                            Reset to brand
                          </Button>
                        ) : null}
                      </div>
                    ))}
                    <p className="mt-2 text-muted-foreground">
                      Individual slide typography and placement remain local. Select a layer to edit
                      or reset those fields.
                    </p>
                  </DisclosureContent>
                </Disclosure>
              ) : null}
              {group.review.source || group.review.wording ? (
                <div role="status" className="flex items-center gap-2 bg-amber-500/10 p-3 text-xs">
                  <span className="flex-1">
                    Review linked screenshots, framing and any local wording before delivery.
                  </span>
                  {canEdit ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => command({ type: 'review-store', groupId: group.id })}
                    >
                      Mark store group reviewed
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="p-2 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {canEdit ? (
                <div className="flex flex-wrap gap-2 border-b px-3 py-1">
                  {group.bindings
                    .filter((binding) => binding.slideId === activeSlideId)
                    .map((binding) => (
                      <span key={binding.layerId} className="text-xs">
                        {binding.field} ·{' '}
                        {binding.overridden ? (
                          <Button
                            variant="custom"
                            size={null}
                            className="underline"
                            onClick={() =>
                              command({
                                type: 'reset-store-binding',
                                groupId: group.id,
                                slideId: binding.slideId,
                                layerId: binding.layerId,
                              })
                            }
                          >
                            Override · reset to story
                          </Button>
                        ) : (
                          'Linked to story'
                        )}
                      </span>
                    ))}
                </div>
              ) : null}
              <div className="flex min-h-0 flex-1">
                {canEdit ? <Sidebar /> : null}
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex min-h-0 flex-1" inert={!canEdit}>
                    <EditorCanvas onFiles={actions.importFiles} />
                  </div>
                  <Filmstrip />
                </div>
                {canEdit ? <Inspector /> : null}
              </div>
            </div>
            <Input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file)
                  void importFiles([file], target.current.kind === 'device' ? target.current : null)
              }}
            />
            {canEdit && dialog === 'import' ? (
              <ImportDialog open onOpenChange={close} initialFiles={[]} />
            ) : null}
            {dialog === 'export' && !group.review.source ? (
              <StoreSetExport
                session={session}
                groupId={group.id}
                canSave={canEdit}
                onClose={() => close(false)}
              />
            ) : null}
            {dialog === 'preview' ? <StorePreviewDialog open onOpenChange={close} /> : null}
            {dialog === 'checks' ? (
              <ChecksDialog open onOpenChange={close} onExport={() => setDialog('export')} />
            ) : null}
            {dialog === 'shortcuts' ? <ShortcutsDialog open onOpenChange={close} /> : null}
            {canEdit && dialog === 'applyStyle' ? (
              <ApplyStyleDialog open onOpenChange={close} />
            ) : null}
            {canEdit && dialog === 'resetSlide' ? (
              <ResetSlideDialog open onOpenChange={close} />
            ) : null}
            {canEdit && dialog === 'animation' ? (
              <StoreMotionDialog
                session={session}
                groupId={group.id}
                flush={flush}
                onClose={() => close(false)}
              />
            ) : null}
            {canEdit ? (
              <StudioFeatureDialogs
                dialog={dialog === 'animation' ? null : dialog}
                onOpenChange={close}
                onCreateProject={(document) => {
                  store.getState().replaceDocument(document)
                  flush()
                  setDialog(null)
                }}
              />
            ) : null}
          </ActiveSceneProvider>
        </StudioActionsProvider>
      </RenderProvider>
    </EditorStoreProvider>
  )
}
