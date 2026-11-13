'use client'

import * as React from 'react'
import {
  instagramUsernameSchema,
  type InstagramOptions as Options,
} from 'screenshot-studio-backend-sdk'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CoverUpload, type UploadFile } from './video-options'

/** Handles written with or without @, split on commas or spaces: the valid ones, distinct, and the rest. */
export function handlesFrom(text: string, limit: number): { handles: string[]; refused: string[] } {
  const handles: string[] = []
  const refused: string[] = []
  for (const word of text.split(/[\s,]+/)) {
    const handle = word.replace(/^@/, '')
    if (!handle) continue
    if (!instagramUsernameSchema.safeParse(handle).success) refused.push(word)
    else if (!handles.some((kept) => kept.toLowerCase() === handle.toLowerCase()))
      handles.push(handle)
  }
  return { handles: handles.slice(0, limit), refused: [...refused, ...handles.slice(limit)] }
}

/** A list of Instagram accounts typed as handles, kept only when Instagram would take them. */
function Handles({
  disabled,
  hint,
  id,
  label,
  limit,
  onChange,
  value,
}: {
  disabled: boolean
  hint: string
  id: string
  label: string
  limit: number
  onChange: (handles: string[] | undefined) => void
  value: string[] | undefined
}) {
  const shown = (handles: string[] | undefined) =>
    (handles ?? []).map((handle) => `@${handle}`).join(' ')
  const [text, setText] = React.useState(() => shown(value))
  const { handles, refused } = handlesFrom(text, limit)
  // A co-editor's change replaces the text, once per saved value: a stored
  // handle this parser reads differently must not set the text on every render.
  const [synced, setSynced] = React.useState(value)
  if (value !== synced) {
    setSynced(value)
    if (handles.join(' ') !== (value ?? []).join(' ')) setText(shown(value))
  }
  return (
    <div className="grid gap-2">
      <div className="flex justify-between">
        <Label htmlFor={id}>{label}</Label>
        <span>
          {value?.length ?? 0}/{limit}
        </span>
      </div>
      <Input
        aria-describedby={`${id}-hint`}
        aria-invalid={refused.length > 0 || undefined}
        disabled={disabled}
        id={id}
        onChange={(event) => {
          setText(event.target.value)
          const { handles } = handlesFrom(event.target.value, limit)
          onChange(handles.length > 0 ? handles : undefined)
        }}
        placeholder="@partner"
        value={text}
      />
      <p id={`${id}-hint`}>
        {refused.length > 0
          ? `Not added: ${refused.join(', ')}. Use up to ${limit} usernames of letters, numbers, dots and underscores.`
          : hint}
      </p>
    </div>
  )
}

/**
 * Instagram's settings beyond the caption: collaborators and tagged accounts
 * for any post, and a reel's cover, grid choice and trial. Go checks them
 * against the post's media before scheduling.
 */
export function InstagramOptions({
  disabled,
  onChange,
  uploadFile,
  value,
}: {
  disabled: boolean
  onChange: (value: Options | undefined) => void
  uploadFile?: UploadFile
  value: Options | undefined
}) {
  const options = value ?? {}
  const change = (next: Partial<Options>) => onChange({ ...options, ...next })
  const story = options.placement === 'story'
  return (
    <div
      className="grid w-full divide-y divide-[var(--divider,var(--border))] text-ui text-muted-foreground [&>*]:px-4 [&>*]:py-2.5 [&_label]:text-ui-lg [&_label]:font-medium [&_label]:text-foreground"
      data-option-rows
      data-testid="instagram-options"
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={story}
          disabled={disabled}
          id="instagram-story"
          // A story takes none of the settings below, so turning it on clears them.
          onCheckedChange={(checked) =>
            onChange(checked === true ? { placement: 'story' } : undefined)
          }
        />
        <div className="grid gap-0.5">
          <Label htmlFor="instagram-story">Post as a story</Label>
          <p>
            One image or video, shown for 24 hours, without a caption: the text goes to your other
            platforms. Collaborators, tags and reel settings don&apos;t apply to stories.
          </p>
        </div>
      </div>
      {story ? null : (
        <>
          <Handles
            disabled={disabled}
            hint="Invited as co-authors: the post shows on their profile once they accept. Use public accounts: Instagram refuses the whole post for a private or misspelled one."
            id="instagram-collaborators"
            label="Collaborators"
            limit={3}
            onChange={(collaborators) => change({ collaborators })}
            value={options.collaborators}
          />
          <Handles
            disabled={disabled}
            hint="Tagged on the first photo, or on the reel. Tag public accounts."
            id="instagram-tags"
            label="Tag accounts"
            limit={20}
            onChange={(userTags) => change({ userTags })}
            value={options.userTags}
          />
          <p className="text-ui-lg font-medium text-foreground">
            Reel settings: for a post of one video
          </p>
          {uploadFile ? (
            <CoverUpload
              assetId={options.coverAssetId}
              channel="instagram"
              disabled={disabled}
              hint="JPEG up to 8 MB; 9:16 works best. Instagram takes the cover with the reel."
              label="Reel cover"
              onChange={(coverAssetId) => change({ coverAssetId })}
              uploadFile={uploadFile}
            />
          ) : null}
          <div className="flex items-start gap-2">
            <Checkbox
              checked={options.shareToFeed !== false}
              disabled={disabled}
              id="instagram-grid"
              onCheckedChange={(checked) =>
                change({ shareToFeed: checked === true ? undefined : false })
              }
            />
            <div className="grid gap-0.5">
              <Label htmlFor="instagram-grid">Show on the profile grid</Label>
              <p>Off keeps the reel in the Reels tab only.</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              checked={options.trialReel ?? false}
              disabled={disabled}
              id="instagram-trial"
              onCheckedChange={(checked) =>
                change(
                  checked === true
                    ? { trialReel: true, trialGraduation: options.trialGraduation ?? 'MANUAL' }
                    : { trialReel: undefined, trialGraduation: undefined }
                )
              }
            />
            <div className="grid gap-0.5">
              <Label htmlFor="instagram-trial">Trial reel</Label>
              <p>
                Shown to non-followers first. Instagram allows it for public professional accounts
                with at least 1,000 followers, up to five a day, and refuses it otherwise.
              </p>
            </div>
          </div>
          {options.trialReel ? (
            <div>
              <Select
                disabled={disabled}
                onValueChange={(graduation) =>
                  change({
                    trialGraduation: graduation === 'SS_PERFORMANCE' ? 'SS_PERFORMANCE' : 'MANUAL',
                  })
                }
                value={options.trialGraduation ?? 'MANUAL'}
              >
                <SelectTrigger aria-label="Share the trial with followers">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MANUAL">Share with followers myself</SelectItem>
                  <SelectItem value="SS_PERFORMANCE">
                    Share with followers if it performs well
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
