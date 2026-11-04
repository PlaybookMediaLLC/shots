'use client'

import { useSocialSets } from '@/components/settings/social-sets/api'
import { isPlanRefusal } from '@/lib/api/platform-errors'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { NotificationSettings } from '@/lib/notifications/schema'

/** The menu's stand-in for an empty value, which a Select item cannot hold. */
const NONE = '__none'

/** Override the shared Slack channel for each workspace-visible publishing brand. */
export function SocialSetSlackDestinations({policy,channels,disabled,onChange}:{
  policy:NotificationSettings['policy']
  channels: Array<{id:string;name:string;isMember:boolean;isArchived:boolean}>
  disabled:boolean
  onChange:(policy:NotificationSettings['policy'])=>void
}) {
  const sets=useSocialSets()
  // By publishing brand, above, already says what the plan is missing.
  if (isPlanRefusal(sets.error)) return null
  if (sets.isError) return <p role="alert">Publishing brands could not be loaded. Reload to change brand destinations.</p>
  if (sets.isPending) return <p role="status">Loading publishing brands…</p>
  const shared=sets.data.items.filter((set) => set.visibility==='WORKSPACE')
  if (!shared.length) return null
  return <fieldset disabled={disabled} className="grid gap-3 border-t pt-4">
    <legend className="text-ui-lg font-medium">Channel by publishing brand</legend>
    <p className="text-xs text-muted-foreground">Use the workspace channel, pick a channel in the connected Slack workspace, or turn shared-channel notices off. Private brands never send to shared channels.</p>
    {shared.map((set) => <Label key={set.id} className="grid gap-1 text-sm">
      {set.name}
      <Select
        value={(policy.socialSetSlackChannels?.[set.id]?.channelId ?? '__inherit') || NONE}
        onValueChange={(choice) => {
        const value = choice === NONE ? '' : choice
        const next={...policy.socialSetSlackChannels}
        if(value==='__inherit') delete next[set.id]
        else next[set.id]={channelId:value,channelName:''}
        onChange({...policy,socialSetSlackChannels:next})
      }}
      >
        <SelectTrigger aria-label={`Slack channel for ${set.name}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__inherit">Workspace channel</SelectItem>
          <SelectItem value={NONE}>No shared-channel notices</SelectItem>
          {channels.map((channel) => <SelectItem key={channel.id} value={channel.id} disabled={!channel.isMember || channel.isArchived}>#{channel.name}{!channel.isMember?' — invite the app first':''}</SelectItem>)}
        </SelectContent>
      </Select>
    </Label>)}
  </fieldset>
}
