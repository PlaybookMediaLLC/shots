'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  downloadDriveFiles,
  DRIVE_MIME_TYPES,
  DRIVE_PICK_LIMIT,
  DRIVE_SCOPE,
  drivePickSchema,
  type GoogleDriveConfig,
} from '@/lib/write/google-drive'

/** The parts of Google's Picker and sign-in scripts Drive import calls. */
type PickerData = Record<string, unknown>
type PickerBuilder = {
  addView(view: unknown): PickerBuilder
  build(): { setVisible(visible: boolean): void }
  enableFeature(feature: string): PickerBuilder
  setAppId(id: string): PickerBuilder
  setCallback(callback: (data: PickerData) => void): PickerBuilder
  setDeveloperKey(key: string): PickerBuilder
  setMaxItems(count: number): PickerBuilder
  setOAuthToken(token: string): PickerBuilder
}
type GoogleScripts = {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        callback: (response: { access_token?: string; error?: string }) => void
        client_id: string
        error_callback?: (error: { type?: string }) => void
        scope: string
      }): { requestAccessToken(): void }
    }
  }
  picker: {
    Action: { CANCEL: string; PICKED: string }
    DocsView: new () => { setIncludeFolders(on: boolean): unknown; setMimeTypes(types: string): unknown }
    Feature: { MULTISELECT_ENABLED: string }
    PickerBuilder: new () => PickerBuilder
    Response: { ACTION: string; DOCUMENTS: string }
  }
}
type DriveWindow = Window & {
  gapi?: { load(name: string, callback: () => void): void }
  google?: GoogleScripts
}

const scripts = new Map<string, Promise<void>>()

/** Loads a script once per page. */
function loadScript(src: string): Promise<void> {
  const loading =
    scripts.get(src) ??
    new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.async = true
      script.src = src
      script.onload = () => resolve()
      script.onerror = () => {
        scripts.delete(src)
        reject(new Error('Google Drive could not be reached. Try again.'))
      }
      document.head.appendChild(script)
    })
  scripts.set(src, loading)
  return loading
}

/** Picker and sign-in, ready to use. */
async function googleScripts(): Promise<GoogleScripts> {
  await Promise.all([
    loadScript('https://apis.google.com/js/api.js'),
    loadScript('https://accounts.google.com/gsi/client'),
  ])
  const page = window as DriveWindow
  await new Promise<void>((resolve) => page.gapi!.load('picker', resolve))
  return page.google!
}

/** The person's `drive.file` token, from Google's own sign-in popup. */
function driveToken(google: GoogleScripts, clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    google.accounts.oauth2
      .initTokenClient({
        callback: (response) =>
          response.access_token
            ? resolve(response.access_token)
            : reject(new Error('Google did not allow access to Drive.')),
        client_id: clientId,
        error_callback: () => reject(new Error('Google sign-in was closed.')),
        scope: DRIVE_SCOPE,
      })
      .requestAccessToken()
  })
}

/**
 * Picks images and videos from the person's Google Drive and hands them to
 * the composer's upload, as if they were dropped in. Unavailable until Shots'
 * Picker keys are deployed.
 */
export function GoogleDriveImport({
  config,
  onClose,
  onFiles,
}: {
  config: GoogleDriveConfig | null
  onClose: () => void
  onFiles: (files: File[]) => void
}) {
  const started = React.useRef(false)
  React.useEffect(() => {
    if (!config || started.current) return
    started.current = true
    void (async () => {
      try {
        const google = await googleScripts()
        const token = await driveToken(google, config.clientId)
        const view = new google.picker.DocsView()
        view.setIncludeFolders(true)
        view.setMimeTypes(DRIVE_MIME_TYPES.join(','))
        new google.picker.PickerBuilder()
          .addView(view)
          .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
          .setMaxItems(DRIVE_PICK_LIMIT)
          .setOAuthToken(token)
          .setDeveloperKey(config.apiKey)
          .setAppId(config.appId)
          .setCallback((data) => {
            const action = data[google.picker.Response.ACTION]
            if (action === google.picker.Action.CANCEL) return onClose()
            if (action !== google.picker.Action.PICKED) return
            const picks = drivePickSchema.array().safeParse(data[google.picker.Response.DOCUMENTS])
            if (!picks.success) {
              toast.error('Google Drive sent files Shots could not read.')
              return onClose()
            }
            void downloadDriveFiles(picks.data, token)
              .then(onFiles)
              .catch((error: unknown) =>
                toast.error(error instanceof Error ? error.message : 'Google Drive import failed.')
              )
              .finally(onClose)
          })
          .build()
          .setVisible(true)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Google Drive import failed.')
        onClose()
      }
    })()
  }, [config, onClose, onFiles])
  if (config) return null
  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Google Drive is not set up</DialogTitle>
          <DialogDescription>
            Importing from Google Drive needs Shots&apos; Google Picker keys, which this
            deployment does not have yet. Upload the files instead.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
