'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useTRPCClient } from '@/lib/trpc/react'
import { newCreativeSetId, type CreativeSetDocument } from '@/lib/creative-sets/document'
import { copyProjectIntoSet } from '@/lib/creative-sets/import-project'
import { fetchAssetUrl } from '@/lib/design/open-design'
import { uploadDesignSources } from '@/lib/design/upload-sources'
import { parseDesignDocument } from '@/lib/design/document'

export function ImportProject({
  onClose,
  onImport,
}: {
  onClose: () => void
  onImport?: (document: CreativeSetDocument) => void
}) {
  const client = useTRPCClient(),
    router = useRouter()
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false)
  const intent = useRef<{
    source: string
    id: string
    name: string
    document: CreativeSetDocument
  } | null>(null)
  useEffect(() => {
    let active = true
    void client.project.list
      .query({ limit: 100 })
      .then((page) => {
        if (active) setProjects(page.items)
      })
      .catch((error) => {
        if (active) setError(error.message)
      })
    return () => {
      active = false
    }
  }, [client])
  async function copy(
    source: string,
    read: () => Promise<{
      id: string
      name: string
      revision: number
      document: unknown
      kind?: 'file'
    }>
  ) {
    setBusy(true)
    setError(null)
    try {
      if (intent.current?.source !== source) {
        const project = await read()
        const document = await uploadDesignSources(client, parseDesignDocument(project.document))
        if (!document.image.src?.startsWith('asset:'))
          throw new Error(
            'This project needs a screenshot before it can become a story. Open it in its original editor to add one.'
          )
        const image = new Image()
        image.src = await fetchAssetUrl(client, document.image.src.slice(6))
        await image.decode()
        intent.current = {
          source,
          id: newCreativeSetId(),
          name: project.name,
          document: await copyProjectIntoSet(
            { ...project, document },
            { width: image.naturalWidth, height: image.naturalHeight }
          ),
        }
      }
      if (onImport) {
        onImport(intent.current.document)
        onClose()
        return
      }
      const result = await client.creativeSet.create.mutate({
        id: intent.current.id,
        name: intent.current.name,
        document: intent.current.document,
      })
      router.push(`/creative-sets/${result.id}`)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The project could not be copied.')
    } finally {
      setBusy(false)
    }
  }
  async function copyFile(file: File) {
    if (file.size > 8 * 1024 * 1024) {
      setError('Choose a design JSON file smaller than 8 MB.')
      return
    }
    const source = `file:${file.name}:${file.size}:${file.lastModified}`
    await copy(source, async () => {
      const bytes = await file.arrayBuffer()
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (byte) => byte.toString(16).padStart(2, '0')
      ).join('')
      return {
        id: hash,
        kind: 'file',
        name: file.name.replace(/\.json$/i, '').slice(0, 200) || 'Imported design',
        revision: 0,
        document: JSON.parse(new TextDecoder().decode(bytes)),
      }
    })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogTitle>Copy an existing project</DialogTitle>
        <DialogDescription>
          Keep the original composition and add three linked formats. The project and all its
          existing versions remain unchanged.
        </DialogDescription>
        <Label className="grid gap-2 text-sm">
          Import a design JSON file
          <FileDropZone
            accept={{ 'application/json': ['.json'] }}
            disabled={busy}
            hint="A design JSON file exported from Shots."
            label="Design JSON file"
            onFiles={(files) => {
              const file = files[0]
              if (file) void copyFile(file)
            }}
          />
        </Label>
        <div className="max-h-96 space-y-2 overflow-auto">
          {projects.map((project) => (
            <Button
              key={project.id}
              className="w-full justify-start"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void copy(project.id, () => client.project.get.query({ projectId: project.id }))
              }
            >
              {project.name}
            </Button>
          ))}
          {!projects.length ? (
            <p className="text-sm text-muted-foreground">No saved projects available.</p>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {busy ? <p role="status">Copying native layers and checking evidence…</p> : null}
      </DialogContent>
    </Dialog>
  )
}
