'use client'

import { useEffect, useState } from 'react'
import { Row } from '@/components/platform-ui'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { settingsHref, SETTINGS_SECTIONS } from '@/components/workspace/settings-sections'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  type SocialSetTransferPreview,
  socialSetTransferPreviewSchema,
  socialSetTransferResultSchema,
} from '@/lib/api/contracts/social-set-transfer'
import { settingsErrorMessage } from '@/lib/settings/client'
import type { SocialSetRecord } from './api'
import { useSocialSetScope } from './scope'

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** A size in megabytes, at least 0.1 MB. */
const megabytes = (bytes: number) => `${Math.max(0.1, bytes / 1_000_000).toFixed(1)} MB`

/** What moving the set does, from its preview. */
function Consequences({ preview }: { preview: SocialSetTransferPreview }) {
  return (
    <ul className="grid list-disc gap-1 pl-5" data-testid="move-consequences">
      <li>
        {plural(preview.drafts, 'draft')} move with their comments, backups and tags
        {preview.mediaFiles > 0
          ? `, and ${plural(preview.mediaFiles, 'file')} (${megabytes(preview.mediaBytes)}) are copied`
          : ''}
        .
      </li>
      {preview.queuedPosts > 0 ? (
        <li>
          {plural(preview.queuedPosts, 'queued post')} will be cancelled; their drafts arrive
          unscheduled.
        </li>
      ) : null}
      {preview.accounts.length > 0 ? (
        <li>
          {plural(preview.accounts.length, 'account')} ({preview.accounts.join(', ')}) stay here,
          disconnected. Connect them again in the destination.
        </li>
      ) : null}
      {preview.publishedPosts > 0 ? (
        <li>
          {plural(preview.publishedPosts, 'published post')} and their analytics stay in this
          workspace&apos;s history.
        </li>
      ) : null}
    </ul>
  )
}

/**
 * Moves a set to another workspace the person owns or administers, after
 * showing where it can go and what the move changes.
 */
export function MoveToWorkspace({ allowed, set }: { allowed: boolean; set: SocialSetRecord }) {
  const scope = useSocialSetScope()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<SocialSetTransferPreview | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [destination, setDestination] = useState('')
  useEffect(() => {
    if (!open) return
    let active = true
    setPreview(null)
    setFailed(null)
    scope
      .request(
        `/api/v1/social-sets/${encodeURIComponent(set.id)}/transfer`,
        socialSetTransferPreviewSchema
      )
      .then((next) => {
        if (!active) return
        setPreview(next)
        setDestination(next.destinations[0]?.organizationId ?? '')
      })
      .catch((error: unknown) => {
        if (active) setFailed(settingsErrorMessage(error))
      })
    return () => {
      active = false
    }
  }, [open, scope, set.id])
  const reason = failed ?? (preview ? preview.blocked || preview.noDestination : '')
  const list = SETTINGS_SECTIONS.find((section) => section.id === 'social-sets')
  return (
    <Row
      description="Its drafts move with their comments, backups, tags and files. Queued posts are cancelled, and its accounts stay here, disconnected."
      label="Move to another workspace"
    >
      <Button disabled={!allowed} onClick={() => setOpen(true)} variant="outline">
        Move to another workspace
      </Button>
      <ConfirmDialog
        confirmLabel="Move profile"
        description={
          preview ? (
            <Consequences preview={preview} />
          ) : failed ? null : (
            <p role="status">Checking where this profile can go…</p>
          )
        }
        destructive
        disabled={!preview || reason !== '' || destination === ''}
        onConfirm={async () => {
          if (!preview) return 'Wait for the preview.'
          try {
            await scope.request(
              `/api/v1/social-sets/${encodeURIComponent(set.id)}/transfer`,
              socialSetTransferResultSchema,
              {
                body: { destinationOrganizationId: destination, version: preview.version },
                method: 'POST',
              }
            )
            window.location.assign(list ? settingsHref(list) : '/settings')
            return null
          } catch (error) {
            return settingsErrorMessage(error)
          }
        }}
        onOpenChange={setOpen}
        open={open}
        title={`Move ${set.name} to another workspace?`}
      >
        {reason ? (
          <p className="text-sm text-muted-foreground" data-testid="move-unavailable" role="alert">
            {reason}
          </p>
        ) : null}
        {preview && preview.destinations.length > 0 ? (
          <Label className="grid gap-1.5">
            Destination workspace
            <Select onValueChange={setDestination} value={destination}>
              <SelectTrigger aria-label="Destination workspace">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {preview.destinations.map((option) => (
                  <SelectItem key={option.organizationId} value={option.organizationId}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
        ) : null}
      </ConfirmDialog>
    </Row>
  )
}
