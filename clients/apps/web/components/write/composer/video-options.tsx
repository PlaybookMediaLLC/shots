'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { youtubeOptionsSchema, tiktokOptionsSchema } from 'screenshot-studio-backend-sdk'
import {
  type AccountStanding,
  YOUTUBE_TAGS_LIMIT,
  youtubeTagsLength,
} from '@/lib/write/capabilities'
import type { DraftChannel, VersionOptions } from '@/lib/write/document'
import { DESTINATION_MEDIA } from '@/lib/write/media-rules'

/** TikTok's privacy levels as a person reads them. */
const TIKTOK_PRIVACY_LABELS: Record<string, string> = {
  FOLLOWER_OF_CREATOR: 'Followers',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  PUBLIC_TO_EVERYONE: 'Everyone',
  SELF_ONLY: 'Only me',
}

/** A TikTok version's settings before any is chosen. */
const TIKTOK_DEFAULTS: NonNullable<VersionOptions['tiktok']> = {
  privacy: '',
  allowComments: false,
  allowDuet: false,
  allowStitch: false,
  commercialContent: false,
  brandOrganic: false,
  brandedContent: false,
  madeWithAi: false,
  consent: false,
}

const YOUTUBE_PRIVACY_LABELS: Record<string, string> = {
  private: 'Private',
  public: 'Public',
  unlisted: 'Unlisted',
}

/**
 * A platform's options in a few words for its chip. TikTok asks for privacy
 * and consent on every post, so they are never filled in for the writer.
 * Whether they block scheduling is the publication's `optionProblems`.
 */
export function optionsSummary(channel: string, options: VersionOptions): string {
  if (channel === 'tiktok') {
    const value = options.tiktok
    if (value?.sendToApp) return 'Draft in the TikTok app'
    if (!value?.privacy) return 'Choose privacy'
    const parts = [
      TIKTOK_PRIVACY_LABELS[value.privacy] ?? value.privacy,
      value.allowComments ? 'comments on' : 'comments off',
    ]
    if (!value.consent) parts.push('consent needed')
    return parts.join(' · ')
  }
  if (channel === 'youtube') {
    const value = options.youtube
    if (!value?.privacy || !value.title.trim() || value.madeForKids === undefined)
      return 'Title, privacy and audience needed'
    return YOUTUBE_PRIVACY_LABELS[value.privacy] ?? value.privacy
  }
  return ''
}

/** A length as people say it: "60 minutes", or "90 seconds" when minutes would be a fraction. */
function durationLabel(seconds: number): string {
  const minutes = seconds / 60
  return Number.isInteger(minutes)
    ? `${minutes} minute${minutes === 1 ? '' : 's'}`
    : `${seconds} seconds`
}

/** Upload a file to the workspace; the composer's upload service. */
export type UploadFile = (file: File) => Promise<{ assetId?: string }>

/**
 * A video's cover or thumbnail: one image in a format and size its
 * destination takes (`cover` in limits.json, which Go checks too).
 */
export function CoverUpload({
  assetId,
  channel,
  disabled,
  hint,
  label,
  onChange,
  uploadFile,
}: {
  assetId?: string
  channel: DraftChannel
  disabled: boolean
  hint: string
  label: string
  onChange: (assetId: string | undefined) => void
  uploadFile: UploadFile
}) {
  const [busy, setBusy] = React.useState(false)
  // The upload can take a while: its result goes into the options as they are
  // when it finishes, not as they were when the file was dropped.
  const latest = React.useRef(onChange)
  React.useEffect(() => {
    latest.current = onChange
  })
  const rules = DESTINATION_MEDIA[channel].cover
  if (!rules) return null
  return (
    <div className="grid gap-1.5">
      <span className="text-ui-lg font-medium text-foreground">{label}</span>
      <FileDropZone
        accept={Object.fromEntries(rules.formats.map((format) => [format, []]))}
        busy={busy}
        disabled={disabled}
        hint={hint}
        label={label}
        maxSize={rules.maxBytes}
        onFiles={async ([file]) => {
          if (!file) return
          setBusy(true)
          try {
            latest.current((await uploadFile(file)).assetId || undefined)
          } catch {
            toast.error(`The ${label.toLowerCase()} could not be uploaded.`)
          } finally {
            setBusy(false)
          }
        }}
        onRemove={() => onChange(undefined)}
        preview={assetId ? <span>{label} added</span> : null}
      />
    </div>
  )
}

/** Comma-separated words as distinct tags, the first spelling of each kept. */
function tagsFrom(text: string): string[] {
  const seen = new Set<string>()
  return text
    .split(',')
    .map((tag) => tag.trim().replace(/[<>]/g, ''))
    .filter((tag) => {
      const key = tag.toLowerCase()
      if (!tag || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** YouTube's tags, its disclosure and a custom thumbnail. */
function YouTubeExtras({
  disabled,
  onChange,
  uploadFile,
  value,
}: {
  disabled: boolean
  onChange: (next: Partial<NonNullable<VersionOptions['youtube']>>) => void
  uploadFile?: UploadFile
  value: NonNullable<VersionOptions['youtube']>
}) {
  const [text, setText] = React.useState(() => (value.tags ?? []).join(', '))
  // A co-editor's change replaces the text, once per saved value: a stored tag
  // this parser reads differently must not set the text on every render.
  const [synced, setSynced] = React.useState(value.tags)
  if (value.tags !== synced) {
    setSynced(value.tags)
    if (tagsFrom(text).join(',') !== (value.tags ?? []).join(','))
      setText((value.tags ?? []).join(', '))
  }
  const length = youtubeTagsLength(value.tags ?? [])
  return (
    <>
      <div className="grid gap-2">
        <div className="flex justify-between">
          <Label htmlFor="youtube-tags">YouTube tags</Label>
          <span
            className={length > YOUTUBE_TAGS_LIMIT ? 'text-destructive' : undefined}
            data-testid="youtube-tags-count"
          >
            {length}/{YOUTUBE_TAGS_LIMIT}
          </span>
        </div>
        <Input
          aria-invalid={length > YOUTUBE_TAGS_LIMIT || undefined}
          disabled={disabled}
          id="youtube-tags"
          onChange={(event) => {
            setText(event.target.value)
            const tags = tagsFrom(event.target.value)
            onChange({ tags: tags.length > 0 ? tags : undefined })
          }}
          placeholder="launch, product demo"
          value={text}
        />
        <p>Separate tags with commas. YouTube counts all of them together.</p>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          checked={value.containsSyntheticMedia ?? false}
          disabled={disabled}
          id="youtube-synthetic"
          onCheckedChange={(checked) =>
            onChange({ containsSyntheticMedia: checked === true ? true : undefined })
          }
        />
        <div className="grid gap-0.5">
          <Label htmlFor="youtube-synthetic">Altered or synthetic content</Label>
          <p>Realistic people, places or events made or changed with AI or editing.</p>
        </div>
      </div>
      {uploadFile ? (
        <CoverUpload
          assetId={value.thumbnailAssetId}
          channel="youtube"
          disabled={disabled}
          hint="JPEG or PNG up to 2 MB; 1280×720 works best. Needs a verified channel, and Shorts ignore it. If YouTube refuses it, the video still goes out."
          label="Custom thumbnail"
          onChange={(thumbnailAssetId) => onChange({ thumbnailAssetId })}
          uploadFile={uploadFile}
        />
      ) : null}
    </>
  )
}

/** Explicit metadata travels with the reviewed platform version, all of it in one place. */
export function VideoOptions({
  channel,
  options,
  onChange,
  disabled,
  creator,
  uploadFile,
}: {
  channel: 'youtube' | 'tiktok'
  options: VersionOptions
  onChange: (options: VersionOptions) => void
  disabled: boolean
  creator?: AccountStanding['tiktokCreator']
  /** Without it, the thumbnail is chosen in the composer rather than here. */
  uploadFile?: UploadFile
}) {
  if (channel === 'youtube') {
    const value = options.youtube ?? { title: '', privacy: '' }
    const missing = !value.title.trim()
      ? 'title'
      : !value.privacy
        ? 'privacy'
        : value.madeForKids === undefined
          ? 'audience'
          : null
    const change = (next: Partial<NonNullable<VersionOptions['youtube']>>) =>
      onChange({ ...options, youtube: { ...value, ...next } })
    return (
      <div
        data-option-rows
        className="grid w-full divide-y divide-[var(--divider,var(--border))] text-ui text-muted-foreground [&>*]:px-4 [&>*]:py-2.5 [&_label]:text-ui-lg [&_label]:font-medium [&_label]:text-foreground"
      >
        <div className="grid gap-2">
          <Label htmlFor="youtube-title">YouTube title</Label>
          <Input
            data-option-missing={missing === 'title' || undefined}
            id="youtube-title"
            value={value.title}
            maxLength={100}
            disabled={disabled}
            onChange={(event) => change({ title: event.target.value })}
          />
        </div>
        {/* Each control is its own row. */}
        <div>
          <Select
            value={value.privacy}
            disabled={disabled}
            onValueChange={(privacy) =>
              change({ privacy: youtubeOptionsSchema.shape.privacy.parse(privacy) })
            }
          >
            <SelectTrigger aria-label="YouTube privacy" data-option-missing={missing === 'privacy' || undefined}>
              <SelectValue placeholder="Choose privacy" />
            </SelectTrigger>
            <SelectContent>
              {['public', 'unlisted', 'private'].map((privacy) => (
                <SelectItem key={privacy} value={privacy}>
                  {YOUTUBE_PRIVACY_LABELS[privacy]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Select
            value={value.madeForKids === undefined ? '' : String(value.madeForKids)}
            disabled={disabled}
            onValueChange={(audience) => change({ madeForKids: audience === 'true' })}
          >
            <SelectTrigger aria-label="YouTube audience" data-option-missing={missing === 'audience' || undefined}>
              <SelectValue placeholder="Choose audience" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">Made for kids</SelectItem>
              <SelectItem value="false">Not made for kids</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {value.privacy === 'private' ? (
          <p className="text-amber-700 dark:text-amber-300" data-testid="private-warning">
            Only you can watch a private video. Choose Public or Unlisted to share it.
          </p>
        ) : null}
        <YouTubeExtras
          disabled={disabled}
          onChange={change}
          uploadFile={uploadFile}
          value={value}
        />
      </div>
    )
  }
  const value = options.tiktok ?? TIKTOK_DEFAULTS
  const change = (next: Partial<NonNullable<VersionOptions['tiktok']>>) =>
    onChange({ ...options, tiktok: { ...value, ...next } })
  return (
    <div
      data-option-rows
      className="grid w-full divide-y divide-[var(--divider,var(--border))] text-ui text-muted-foreground [&>*]:px-4 [&>*]:py-2.5 [&_label]:text-ui-lg [&_label]:font-medium [&_label]:text-foreground"
    >
      <p>
        {creator
          ? `Posting to ${creator.nickname}. Maximum video length: ${durationLabel(creator.maxDurationSeconds)}.`
          : 'TikTok permissions are unavailable. Refresh the account before scheduling.'}
      </p>
      <div className="flex items-start gap-2">
        <Checkbox
          checked={value.sendToApp ?? false}
          disabled={disabled}
          id="tiktok-send-to-app"
          // TikTok takes only the caption with an app draft, so every other setting resets.
          onCheckedChange={(checked) =>
            onChange({
              ...options,
              tiktok: checked === true ? { ...TIKTOK_DEFAULTS, sendToApp: true } : TIKTOK_DEFAULTS,
            })
          }
        />
        <div className="grid gap-0.5">
          <Label htmlFor="tiktok-send-to-app">Send to the TikTok app as a draft</Label>
          <p>
            At the scheduled time the video and caption go to your TikTok inbox, where you choose
            who sees it and post it. It is not a Shots draft, and Shots does not see when it goes
            live.
          </p>
        </div>
      </div>
      {value.sendToApp ? null : (
        <TikTokDirectPost change={change} creator={creator} disabled={disabled} value={value} />
      )}
    </div>
  )
}

/** The settings TikTok applies when Shots posts the video itself. */
function TikTokDirectPost({
  change,
  creator,
  disabled,
  value,
}: {
  change: (next: Partial<NonNullable<VersionOptions['tiktok']>>) => void
  creator?: AccountStanding['tiktokCreator']
  disabled: boolean
  value: NonNullable<VersionOptions['tiktok']>
}) {
  const controls = [
    { key: 'allowComments', label: 'Allow comments', unavailable: creator?.commentDisabled },
    { key: 'allowDuet', label: 'Allow Duet', unavailable: creator?.duetDisabled },
    { key: 'allowStitch', label: 'Allow Stitch', unavailable: creator?.stitchDisabled },
    { key: 'brandOrganic', label: 'Promotes your brand (Promotional content)', unavailable: false },
    {
      key: 'brandedContent',
      label: 'Promotes another brand (Paid partnership)',
      unavailable: value.privacy === 'SELF_ONLY',
    },
    { key: 'madeWithAi', label: 'AI-generated video', unavailable: false },
  ] as const
  return (
    <>
      <div>
        <Select
          disabled={disabled || !creator}
          value={value.privacy}
          onValueChange={(privacy) =>
            change({ privacy: tiktokOptionsSchema.shape.privacy.parse(privacy), consent: false })
          }
        >
          <SelectTrigger
            aria-label="TikTok privacy"
            data-option-missing={
              !value.privacy ||
              (creator && !creator.privacyLevels.includes(value.privacy)) ||
              undefined
            }
          >
            <SelectValue placeholder="Choose privacy" />
          </SelectTrigger>
          <SelectContent>
            {creator?.privacyLevels.map((privacy) => (
              <SelectItem
                key={privacy}
                value={privacy}
                disabled={privacy === 'SELF_ONLY' && value.brandedContent}
              >
                {TIKTOK_PRIVACY_LABELS[privacy] ?? privacy}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {value.privacy === 'SELF_ONLY' ? (
        <p className="text-amber-700 dark:text-amber-300" data-testid="private-warning">
          Only you will see this post on TikTok. Choose another audience to share it.
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Checkbox
          data-option-missing={(Boolean(value.privacy) && !value.consent) || undefined}
          id="tiktok-consent"
          checked={value.consent}
          disabled={disabled || !creator}
          onCheckedChange={(checked) => change({ consent: checked === true })}
        />
        <Label htmlFor="tiktok-consent">
          I consent to send this video to TikTok at the scheduled time.
        </Label>
      </div>
      <p>
        By posting, you agree to TikTok’s{' '}
        <a
          className="underline underline-offset-2 hover:text-foreground"
          href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
          target="_blank"
          rel="noreferrer"
        >
          Music Usage Confirmation
        </a>
        {value.brandedContent && (
          <>
            {' '}
            and{' '}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href="https://www.tiktok.com/legal/page/global/bc-policy/en"
              target="_blank"
              rel="noreferrer"
            >
              Branded Content Policy
            </a>
          </>
        )}
        . Processing may take a few minutes before the video appears.
      </p>
      <div className="flex items-center gap-2">
        <Checkbox
          id="tiktok-commercial"
          checked={value.commercialContent ?? false}
          disabled={disabled || !creator}
          onCheckedChange={(checked) =>
            change({
              commercialContent: checked === true,
              brandOrganic: false,
              brandedContent: false,
              consent: false,
            })
          }
        />
        <Label htmlFor="tiktok-commercial">Disclose commercial content</Label>
      </div>
      {controls
        .filter(
          ({ key }) =>
            value.commercialContent || (key !== 'brandOrganic' && key !== 'brandedContent')
        )
        .map(({ key, label, unavailable }) => (
          <div className="flex items-center gap-2" key={key}>
            <Checkbox
              id={`tiktok-${key}`}
              checked={value[key]}
              disabled={disabled || !creator || unavailable}
              onCheckedChange={(checked) => change({ [key]: checked === true, consent: false })}
            />
            <Label htmlFor={`tiktok-${key}`}>{label}</Label>
          </div>
        ))}
      {value.brandedContent ? (
        <p>Your video will be labeled as “Paid partnership”.</p>
      ) : value.brandOrganic ? (
        <p>Your video will be labeled as “Promotional content”.</p>
      ) : null}
      {value.commercialContent && !value.brandOrganic && !value.brandedContent && (
        <p>Indicate whether your content promotes yourself, a third party, or both.</p>
      )}
      {value.privacy === 'SELF_ONLY' && value.commercialContent ? (
        <p>Branded content visibility cannot be private.</p>
      ) : null}
    </>
  )
}
