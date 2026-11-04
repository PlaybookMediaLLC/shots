'use client'

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
import type { AccountStanding } from '@/lib/write/capabilities'
import type { VersionOptions } from '@/lib/write/document'

/** Explicit metadata travels with the reviewed platform version. */
export function VideoOptions({
  channel,
  options,
  onChange,
  disabled,
  creator,
}: {
  channel: 'youtube' | 'tiktok'
  options: VersionOptions
  onChange: (options: VersionOptions) => void
  disabled: boolean
  creator?: AccountStanding['tiktokCreator']
}) {
  if (channel === 'youtube') {
    const value = options.youtube ?? { title: '', privacy: '' }
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
            <SelectTrigger aria-label="YouTube privacy">
              <SelectValue placeholder="Choose privacy" />
            </SelectTrigger>
            <SelectContent>
              {['public', 'unlisted', 'private'].map((privacy) => (
                <SelectItem key={privacy} value={privacy}>
                  {privacy}
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
            <SelectTrigger aria-label="YouTube audience">
              <SelectValue placeholder="Choose audience" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">Made for kids</SelectItem>
              <SelectItem value="false">Not made for kids</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    )
  }
  const value = options.tiktok ?? {
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
  const change = (next: Partial<NonNullable<VersionOptions['tiktok']>>) =>
    onChange({ ...options, tiktok: { ...value, ...next } })
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
    <div
      data-option-rows
      className="grid w-full divide-y divide-[var(--divider,var(--border))] text-ui text-muted-foreground [&>*]:px-4 [&>*]:py-2.5 [&_label]:text-ui-lg [&_label]:font-medium [&_label]:text-foreground"
    >
      <p>
        {creator
          ? `Posting to ${creator.nickname}. Maximum video length: ${creator.maxDurationSeconds} seconds.`
          : 'TikTok permissions are unavailable. Refresh the account before scheduling.'}
      </p>
      <div>
        <Select
          disabled={disabled || !creator}
          value={value.privacy}
          onValueChange={(privacy) =>
            change({ privacy: tiktokOptionsSchema.shape.privacy.parse(privacy), consent: false })
          }
        >
          <SelectTrigger aria-label="TikTok privacy">
            <SelectValue placeholder="Choose privacy" />
          </SelectTrigger>
          <SelectContent>
            {creator?.privacyLevels.map((privacy) => (
              <SelectItem
                key={privacy}
                value={privacy}
                disabled={privacy === 'SELF_ONLY' && value.brandedContent}
              >
                {privacy}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
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
      {value.privacy === 'SELF_ONLY' && <p>Branded content visibility cannot be private.</p>}
      <div className="flex items-center gap-2">
        <Checkbox
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
    </div>
  )
}
