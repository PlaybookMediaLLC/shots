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
import { DRAFT_MEDIA_TYPES } from '@/lib/platform/asset-handoff'
import {
  downloadDriveFiles,
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
    DocsView: new () => {
      setIncludeFolders(on: boolean): unknown
      setMimeTypes(types: string): unknown
    }
    Feature: { MULTISELECT_ENABLED: string }
    PickerBuilder: new () => PickerBuilder
    Response: { ACTION: string; DOCUMENTS: string }
  }
}
type DriveWindow = Window & {
  gapi?: {
    load(
      name: string,
      options: { callback: () => void; onerror: () => void; ontimeout: () => void; timeout: number }
    ): void
  }
  google?: GoogleScripts
}

const UNREACHABLE = 'Google Drive could not be reached. Try again.'
const scripts = new Map<string, Promise<void>>()

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
        reject(new Error(UNREACHABLE))
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
  const gapi = page.gapi
  if (!gapi) throw new Error(UNREACHABLE)
  await new Promise<void>((resolve, reject) =>
    gapi.load('picker', {
      callback: resolve,
      onerror: () => reject(new Error(UNREACHABLE)),
      ontimeout: () => reject(new Error(UNREACHABLE)),
      timeout: 15_000,
    })
  )
  if (!page.google?.picker || !page.google.accounts) throw new Error(UNREACHABLE)
  return page.google
}

/**
 * Picks images and videos from the person's Google Drive and hands them to
 * the composer's upload, as if they were dropped in. Google's sign-in opens
 * from the dialog's button, inside the click, so no browser blocks it.
 * Closing the dialog cancels the import. Unavailable until Shots' Picker keys
 * are deployed.
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
  const [google, setGoogle] = React.useState<GoogleScripts | null>(null)
  const [state, setState] = React.useState<
    { kind: 'ready' } | { kind: 'busy'; text: string } | { kind: 'failed'; text: string }
  >({ kind: 'ready' })
  const downloads = React.useRef<AbortController | null>(null)
  React.useEffect(() => {
    if (!config) return
    let current = true
    googleScripts()
      .then((loaded) => current && setGoogle(loaded))
      .catch((error: unknown) => {
        if (current) setState({ kind: 'failed', text: message(error) })
      })
    return () => {
      current = false
      downloads.current?.abort()
    }
  }, [config])

  const pick = (token: string, scripts: GoogleScripts, keys: GoogleDriveConfig) => {
    const view = new scripts.picker.DocsView()
    view.setIncludeFolders(true)
    view.setMimeTypes(DRAFT_MEDIA_TYPES.join(','))
    new scripts.picker.PickerBuilder()
      .addView(view)
      .enableFeature(scripts.picker.Feature.MULTISELECT_ENABLED)
      .setMaxItems(DRIVE_PICK_LIMIT)
      .setOAuthToken(token)
      .setDeveloperKey(keys.apiKey)
      .setAppId(keys.appId)
      .setCallback((data) => {
        const action = data[scripts.picker.Response.ACTION]
        if (action === scripts.picker.Action.CANCEL) return setState({ kind: 'ready' })
        if (action !== scripts.picker.Action.PICKED) return
        const picks = drivePickSchema.array().safeParse(data[scripts.picker.Response.DOCUMENTS])
        if (!picks.success)
          return setState({ kind: 'failed', text: 'Google Drive sent files Shots could not read.' })
        const controller = new AbortController()
        downloads.current = controller
        const count = picks.data.length
        setState({
          kind: 'busy',
          text: `Downloading ${count === 1 ? '1 file' : `${count} files`}…`,
        })
        downloadDriveFiles(picks.data, token, { signal: controller.signal })
          .then(({ failed, files }) => {
            if (controller.signal.aborted) return
            if (failed.length) toast.error(`Google Drive did not send ${failed.join(', ')}.`)
            if (files.length) onFiles(files)
            onClose()
          })
          .catch((error: unknown) => {
            if (!controller.signal.aborted) setState({ kind: 'failed', text: message(error) })
          })
      })
      .build()
      .setVisible(true)
  }

  // Inside the click: Google's sign-in popup opens only from a person's gesture.
  const choose = () => {
    if (!google || !config) return
    setState({ kind: 'busy', text: 'Waiting for Google…' })
    google.accounts.oauth2
      .initTokenClient({
        callback: (response) =>
          response.access_token
            ? pick(response.access_token, google, config)
            : setState({ kind: 'failed', text: 'Google did not allow access to Drive.' }),
        client_id: config.clientId,
        error_callback: (error) =>
          setState(
            error.type === 'popup_failed_to_open'
              ? { kind: 'failed', text: 'Allow pop-ups for Shots, then try again.' }
              : { kind: 'ready' }
          ),
        scope: DRIVE_SCOPE,
      })
      .requestAccessToken()
  }

  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {config ? 'Import from Google Drive' : 'Google Drive is not set up'}
          </DialogTitle>
          <DialogDescription>
            {config
              ? `Choose up to ${DRIVE_PICK_LIMIT} images and videos. Google asks you to sign in and lets Shots open only the files you pick.`
              : 'Importing from Google Drive needs Shots’ Google Picker keys, which this deployment does not have yet. Upload the files instead.'}
          </DialogDescription>
        </DialogHeader>
        {state.kind === 'failed' ? (
          <p className="text-sm text-destructive" role="alert">
            {state.text}
          </p>
        ) : state.kind === 'busy' ? (
          <p className="text-sm text-muted-foreground" role="status">
            {state.text}
          </p>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose} variant={config ? 'outline' : 'default'}>
            {config ? 'Cancel' : 'Close'}
          </Button>
          {config ? (
            <Button disabled={!google || state.kind === 'busy'} onClick={choose}>
              {google ? 'Choose from Google Drive' : 'Loading Google Drive…'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Google Drive import failed.'
}
