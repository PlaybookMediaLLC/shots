'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { Group, Section } from '@/components/platform-ui'
import { EmailSwitch, SocialSetNotifications } from '@/components/settings/NotificationExtras'
import { SocialSetSlackDestinations } from '@/components/settings/SocialSetSlackDestinations'
import { NotificationPreferenceTable } from '@/components/settings/NotificationPreferenceTable'
import { SettingsSaveBar } from '@/components/settings/SettingsSaveBar'
import { useUnsavedSettings } from '@/components/settings/useUnsavedSettings'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PersonalNotificationDeliveries } from '@/components/settings/PersonalNotificationDeliveries'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  notificationRequest,
  NotificationRequestError,
  useNotificationIdentity,
  useNotificationPageVisible,
} from '@/lib/notifications/client'
import {
  notificationDeliverySchema,
  notificationSettingsSchema,
  notificationSlackChannelsSchema,
  type NotificationSettings,
} from '@/lib/notifications/schema'
import { preferenceChannels, preferenceSelected } from '@/lib/notifications/preferences'

/** How many of a group's events reach you on any channel, such as "3 of 8 on". */
function groupSummary(
  preferences: NotificationSettings['preferences'],
  events: NotificationSettings['catalogue']
): string {
  const on = events.filter((event) =>
    preferenceChannels.some((channel) => preferenceSelected(preferences, event.id, channel.id))
  ).length
  return `${on} of ${events.length} on`
}

function SettingsForm({
  initial,
  identity,
}: {
  initial: NotificationSettings
  identity: ReturnType<typeof useNotificationIdentity>
}) {
  const queryClient = useQueryClient()
  const search = useSearchParams()
  const visible = useNotificationPageVisible()
  const [settings, setSettings] = useState(initial)
  const [policy, setPolicy] = useState(initial.policy)
  const [preferences, setPreferences] = useState(initial.preferences)
  const [busy, setBusy] = useState('')
  const [panel, setPanel] = useState(
    search.get('connected') !== 'personal-slack' &&
      initial.canManage &&
      (search.has('connected') || search.has('error'))
      ? 'delivery'
      : 'personal'
  )
  const { preferences: personal, save: savePersonal } = usePreferences()
  // The email switch is a personal preference; it saves with the rest of these preferences.
  const [email, setEmail] = useState<boolean | null>(null)
  const savedEmail = personal?.emailNotifications !== false
  const emailDirty = email !== null && email !== savedEmail
  const preferencesDirty =
    emailDirty || JSON.stringify(preferences) !== JSON.stringify(settings.preferences)
  const policyDirty = JSON.stringify(policy) !== JSON.stringify(settings.policy)
  useUnsavedSettings(preferencesDirty || policyDirty)
  const [preferencesConflict, setPreferencesConflict] = useState(false)
  const [error, setError] = useState(
    search.has('error')
      ? 'Slack did not connect. Check your workspace and permissions, then try again.'
      : ''
  )
  const [saved, setSaved] = useState(
    search.has('connected')
      ? search.get('connected') === 'personal-slack'
        ? 'Your Slack account is connected. Choose which direct messages to receive below.'
        : 'Slack connected. Select a destination and save your workspace policy.'
      : ''
  )
  const [testDelivery, setTestDelivery] = useState('')
  const [testUntil, setTestUntil] = useState<Record<string, number>>({})
  useEffect(() => {
    const deadlines = Object.values(testUntil)
    if (!deadlines.length) return
    const timer = setTimeout(
      () =>
        setTestUntil((current) =>
          Object.fromEntries(Object.entries(current).filter(([, until]) => until > Date.now()))
        ),
      Math.max(1, Math.min(...deadlines) - Date.now())
    )
    return () => clearTimeout(timer)
  }, [testUntil])
  const channels = useQuery({
    queryKey: [...identity.key, 'slack-channels', policy.slackConnectionId],
    enabled: settings.canManage && !!policy.slackConnectionId,
    queryFn: async ({ signal }) => {
      const result: z.infer<typeof notificationSlackChannelsSchema>['channels'] = []
      const visited = new Set<string>()
      let cursor = ''
      do {
        if (visited.has(cursor))
          throw new Error('Slack returned a repeated channel cursor. Reconnect and try again.')
        visited.add(cursor)
        const page = await notificationRequest(
          identity,
          `/slack/channels?connectionId=${encodeURIComponent(policy.slackConnectionId)}&cursor=${encodeURIComponent(cursor)}`,
          notificationSlackChannelsSchema,
          { signal }
        )
        result.push(...page.channels)
        cursor = page.nextCursor
      } while (cursor)
      return result
    },
  })
  const deliveries = useQuery({
    queryKey: [...identity.key, 'deliveries'],
    queryFn: ({ signal }) =>
      notificationRequest(
        identity,
        '/deliveries',
        z.object({ deliveries: z.array(notificationDeliverySchema) }),
        { signal }
      ),
    enabled: settings.canManage && visible,
    refetchInterval: visible ? 30_000 : false,
    refetchIntervalInBackground: false,
  })

  async function perform(name: string, action: () => Promise<void>) {
    setBusy(name)
    setError('')
    setSaved('')
    try {
      await action()
    } catch (failure) {
      if (
        name === 'preferences' &&
        failure instanceof NotificationRequestError &&
        failure.status === 409
      ) {
        setPreferencesConflict(true)
        setError(
          'Your preferences changed in another tab. Reload saved preferences, then apply your changes again.'
        )
        return
      }
      setError(
        failure instanceof Error ? failure.message : 'Changes could not be saved. Try again.'
      )
    } finally {
      setBusy('')
    }
  }
  async function save(section: 'policy' | 'preferences') {
    await perform(section, async () => {
      if (section === 'preferences' && emailDirty && email !== null) {
        const result = await savePersonal({ emailNotifications: email })
        if (!result.ok) throw new Error(result.error)
        setEmail(null)
      }
      const next = await notificationRequest(identity, `/${section}`, notificationSettingsSchema, {
        method: 'PUT',
        body: section === 'policy' ? policy : preferences,
      })
      if (section === 'preferences') setPreferencesConflict(false)
      setSettings(next)
      if (section === 'policy') setPolicy(next.policy)
      else setPreferences(next.preferences)
      queryClient.setQueryData([...identity.key, 'settings'], next)
      setSaved(section === 'policy' ? 'Workspace policy saved.' : 'Your preferences are saved.')
    })
  }
  async function connect(purpose: 'notifications' | 'personal' = 'notifications') {
    await perform('connect', async () => {
      const result = await notificationRequest(
        identity,
        '/slack/connect',
        z.object({ url: z.string().url() }),
        {
          method: 'POST',
          body: {
            purpose,
            connectionId:
              (purpose === 'personal' ? settings.personalSlack?.id : policy.slackConnectionId) ||
              undefined,
          },
        }
      )
      window.location.assign(result.url)
    })
  }
  async function disconnect(id: string) {
    if (
      policyDirty &&
      !window.confirm('Disconnect Slack and discard unsaved workspace policy changes?')
    )
      return
    await perform('disconnect', async () => {
      await notificationRequest(
        identity,
        `/slack/${encodeURIComponent(id)}`,
        z.object({ disconnected: z.boolean() }),
        { method: 'DELETE' }
      )
      const next = await notificationRequest(identity, '', notificationSettingsSchema)
      setSettings(next)
      setPolicy(next.policy)
      queryClient.setQueryData([...identity.key, 'settings'], next)
      setSaved('Slack disconnected from this workspace.')
    })
  }
  async function test(channel: 'email' | 'slack' | 'slack_dm') {
    await perform(`test-${channel}`, async () => {
      const result = await notificationRequest(
        identity,
        '/test',
        z.object({ deliveryId: z.string() }),
        { method: 'POST', body: { channel, key: crypto.randomUUID() } }
      )
      setTestUntil((current) => ({ ...current, [channel]: Date.now() + 60_000 }))
      setTestDelivery(result.deliveryId)
      setSaved('Test queued. Its status appears below.')
      await queryClient.invalidateQueries({ queryKey: [...identity.key, 'deliveries'] })
    })
  }
  async function disconnectPersonal() {
    const id = settings.personalSlack?.id
    if (!id) return
    await perform('disconnect-personal', async () => {
      await notificationRequest(
        identity,
        `/slack/personal/${encodeURIComponent(id)}`,
        z.object({ disconnected: z.boolean() }),
        { method: 'DELETE' }
      )
      const next = await notificationRequest(identity, '', notificationSettingsSchema)
      setSettings(next)
      queryClient.setQueryData([...identity.key, 'settings'], next)
      setSaved('Your Slack direct messages are disconnected.')
    })
  }
  const groups = [...new Set(settings.catalogue.map((event) => event.group))]
  const personalGroup = (group: string) => (group === 'mentions' ? 'comments' : group)
  const personalGroups = [...new Set(settings.catalogue.map((event) => personalGroup(event.group)))]
  const selected = settings.connections.find(
    (connection) => connection.id === policy.slackConnectionId
  )
  return (
    <fieldset disabled={!!busy} className="flex min-w-0 flex-col gap-8">
      <div className="flex flex-wrap gap-2" aria-label="Notification settings">
        {[
          ['personal', 'My notifications'],
          ...(settings.canManage
            ? [
                ['policy', 'Workspace rules'],
                ['delivery', 'Delivery & Slack'],
              ]
            : []),
        ].map(([id, label]) => (
          <Button
            key={id}
            type="button"
            aria-pressed={panel === id}
            variant={panel === id ? 'default' : 'outline'}
            onClick={() => setPanel(id!)}
          >
            {label}
            {(id === 'personal' && preferencesDirty) || (id !== 'personal' && policyDirty)
              ? ' •'
              : ''}
          </Button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        Choose the activity you receive in this workspace. Authentication, invitations, and required
        security messages keep their own delivery rules.
      </p>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {preferencesConflict ? (
        <Button
          variant="outline"
          onClick={() =>
            void perform('reload', async () => {
              const next = await notificationRequest(identity, '', notificationSettingsSchema)
              setSettings(next)
              setPreferences(next.preferences)
              setPreferencesConflict(false)
              setSaved('Saved preferences loaded. Unsaved personal changes were discarded.')
            })
          }
        >
          Reload saved preferences and discard my changes
        </Button>
      ) : null}
      {testDelivery ? <TestDeliveryStatus identity={identity} id={testDelivery} /> : null}
      {saved ? (
        <p role="status" className="rounded-lg border border-emerald-500/30 p-4 text-sm">
          {saved}
        </p>
      ) : null}

      <div hidden={panel !== 'personal'} className="space-y-8">
        <Section
          title="Email"
          description="Your switch for activity email in every workspace. It saves with your preferences below."
        >
          <EmailSwitch checked={email ?? savedEmail} disabled={!personal || !!busy} onCheckedChange={setEmail} />
        </Section>

        <Section
          title="Personal Slack messages"
          description="Receive your notifications in a direct message from Shots. Choose the Slack account you want to use on the authorization screen."
        >
          <Group>
            <div className="space-y-3 p-5">
              <Label className="flex items-center justify-between gap-4 text-sm">
                <span>Allow personal Slack messages in this workspace</span>
                <Switch
                  aria-label="Personal Slack messages"
                  checked={preferences.slackEnabled !== false}
                  onCheckedChange={(slackEnabled) =>
                    setPreferences((current) => ({ ...current, slackEnabled }))
                  }
                />
              </Label>
              <p className="text-xs text-muted-foreground">
                Save preferences below to apply this switch. Off pauses all activity DMs, including
                required failure alerts. An explicit test can still send one message.
              </p>
              <p className="text-sm">
                {settings.personalSlack
                  ? `${settings.personalSlack.teamName} · ${settings.personalSlack.slackUserId} · ${settings.personalSlack.health === 'CONNECTED' ? 'Connected' : 'Reconnect required'}`
                  : 'No personal Slack account connected.'}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  disabled={!settings.slackAvailable || preferencesDirty || policyDirty}
                  onClick={() => void connect('personal')}
                >
                  {settings.personalSlack ? 'Reconnect my Slack' : 'Connect my Slack'}
                </Button>
                {settings.personalSlack ? (
                  <Button variant="outline" onClick={() => void disconnectPersonal()}>
                    Disconnect my Slack
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  disabled={
                    settings.personalSlack?.health !== 'CONNECTED' ||
                    !settings.policy.availability.slack ||
                    !!testUntil.slack_dm
                  }
                  onClick={() => void test('slack_dm')}
                >
                  Send test to my Slack
                </Button>
              </div>
              {!settings.slackAvailable ? (
                <p className="text-sm text-muted-foreground">
                  Slack is unavailable. Contact your administrator to enable it.
                </p>
              ) : null}
              {preferencesDirty || policyDirty ? (
                <p className="text-sm text-muted-foreground">
                  Save or discard changes before connecting Slack.
                </p>
              ) : null}
            </div>
          </Group>
        </Section>

        <Section
          title="Your preferences"
          description="Group controls change optional alerts. Publishing failures and uncertain publishing results are required alerts, including your own actions. Workspace rules, email and personal Slack switches, and connection health still control delivery. Save changes to apply them."
        >
          <Group>
            {personalGroups.map((group) => (
              <Disclosure
                className="border-b border-border last:border-0"
                key={group}
                defaultOpen={group === 'reviews'}
              >
                <DisclosureTrigger
                  className="px-5 py-4 text-ui-lg font-medium capitalize"
                  summary={groupSummary(
                    preferences,
                    settings.catalogue.filter((event) => personalGroup(event.group) === group)
                  )}
                >
                  {group === 'publishing' ? 'Publishing defaults' : group}
                </DisclosureTrigger>
                <DisclosureContent>
                  <div className="px-5 pb-4">
                    {group === 'publishing' ? (
                      <p className="mb-3 text-xs text-muted-foreground">
                        Used unless you choose a channel for a specific publishing brand below.
                      </p>
                    ) : null}
                    <NotificationPreferenceTable
                      events={settings.catalogue.filter(
                        (event) => personalGroup(event.group) === group
                      )}
                      group={group === 'publishing' ? 'publishing defaults' : group}
                      value={preferences}
                      onChange={setPreferences}
                      settings={settings}
                      emailEnabled={email ?? savedEmail}
                    />
                  </div>
                </DisclosureContent>
              </Disclosure>
            ))}
          </Group>
          <div className="mt-6">
            <SocialSetNotifications
              disabled={!!busy}
              onChange={setPreferences}
              value={preferences}
              settings={settings}
              emailEnabled={email ?? savedEmail}
            />
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={!!busy || !settings.emailAvailable || !!testUntil.email}
              onClick={() => void test('email')}
            >
              Send test to my email
            </Button>
          </div>
          {!settings.emailAvailable ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Email is unavailable until an administrator configures delivery.
            </p>
          ) : null}
        </Section>

        <SettingsSaveBar
          dirty={preferencesDirty}
          busy={busy === 'preferences'}
          label="Save my preferences"
          onSave={() => void save('preferences')}
          onDiscard={() => {
            setPreferences(settings.preferences)
            setEmail(null)
          }}
        />
      </div>
      <div hidden={panel !== 'personal'}>
        <PersonalNotificationDeliveries identity={identity} settings={settings} />
      </div>
      {settings.canManage ? (
        <>
          <div hidden={panel !== 'delivery'}>
            <Section
              title="Slack destination"
              description="Save workspace policy applies changes from both Workspace rules and Delivery & Slack. A shared channel receives only permitted activity; private activity stays with its recipients."
            >
              <Group>
                <div className="flex flex-col gap-4 p-5">
                  {!settings.slackAvailable ? (
                    <p className="text-sm text-muted-foreground">
                      Slack is unavailable. Contact your administrator to enable it.
                    </p>
                  ) : null}
                  {settings.connections.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No Slack workspace is connected.
                    </p>
                  ) : null}
                  <Label className="grid gap-2 text-sm">
                    Slack workspace
                    <Select
                      value={policy.slackConnectionId}
                      onValueChange={(slackConnectionId) =>
                        setPolicy((current) => ({
                          ...current,
                          slackConnectionId,
                          slackChannelId: '',
                          slackChannelName: '',
                          socialSetSlackChannels: {},
                        }))
                      }
                    >
                      <SelectTrigger aria-label="Slack workspace" className="w-full">
                        <SelectValue placeholder="Select a connection" />
                      </SelectTrigger>
                      <SelectContent>
                        {settings.connections.map((connection) => (
                          <SelectItem key={connection.id} value={connection.id}>
                            {connection.teamName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Label>
                  {selected ? (
                    <p className="text-xs text-muted-foreground">
                      {selected.health === 'CONNECTED' ? 'Connected' : 'Reconnect required'}
                    </p>
                  ) : null}
                  <Label className="grid gap-2 text-sm">
                    Channel
                    <Select
                      disabled={!policy.slackConnectionId || channels.isPending}
                      value={policy.slackChannelId}
                      onValueChange={(slackChannelId) =>
                        setPolicy((current) => ({ ...current, slackChannelId }))
                      }
                    >
                      <SelectTrigger aria-label="Slack channel" className="w-full">
                        <SelectValue placeholder="Select a channel" />
                      </SelectTrigger>
                      <SelectContent>
                        {channels.data?.map((channel) => (
                          <SelectItem
                            key={channel.id}
                            value={channel.id}
                            disabled={!channel.isMember || channel.isArchived}
                          >
                            {channel.isPrivate ? 'Private: ' : '#'}
                            {channel.name}
                            {!channel.isMember ? ' — invite the app first' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Label>
                  {policy.slackConnectionId && channels.isPending ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      Loading Slack channels…
                    </p>
                  ) : null}
                  <SocialSetSlackDestinations
                    policy={policy}
                    channels={channels.data ?? []}
                    disabled={!!busy || !policy.slackConnectionId || channels.isPending}
                    onChange={setPolicy}
                  />
                  {channels.error ? (
                    <p role="alert" className="text-sm text-destructive">
                      {channels.error.message}
                    </p>
                  ) : null}
                  {channels.data?.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No available channels. Invite the Slack app to a channel, then refresh.
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={!!busy || !settings.slackAvailable}
                      onClick={() => void connect()}
                    >
                      {selected ? 'Reconnect Slack' : 'Connect Slack'}
                    </Button>
                    {selected ? (
                      <Button
                        variant="outline"
                        disabled={!!busy}
                        onClick={() => void disconnect(selected.id)}
                      >
                        Disconnect
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      disabled={!policy.slackConnectionId || channels.isFetching}
                      onClick={() => void channels.refetch()}
                    >
                      Refresh channels
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Invite the app to private channels. Save the workspace policy before testing a
                    new destination.
                  </p>
                  <Button
                    variant="outline"
                    disabled={!!busy || !settings.policy.slackChannelId || !!testUntil.slack}
                    onClick={() => void test('slack')}
                  >
                    Send test to selected channel
                  </Button>
                </div>
              </Group>
            </Section>
            <SettingsSaveBar
              dirty={policyDirty}
              busy={busy === 'policy'}
              label="Save workspace policy"
              onSave={() => void save('policy')}
              onDiscard={() => setPolicy(settings.policy)}
            />
          </div>
          <div hidden={panel !== 'policy'}>
            <Section
              title="Workspace policy"
              description="Owners and administrators choose which categories each channel can deliver. Email categories start disabled. New workspace policies enable published-post Slack notices when Slack is connected."
            >
              <fieldset className="mb-4 flex flex-wrap gap-5" disabled={!!busy}>
                <legend className="mb-3 text-ui-lg font-medium">Available channels</legend>
                {(['inApp', 'email', 'slack'] as const).map((channel) => (
                  <Label key={channel} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={policy.availability[channel]}
                      onCheckedChange={(checked) =>
                        setPolicy((current) => ({
                          ...current,
                          availability: {
                            ...current.availability,
                            [channel]: checked === true,
                          },
                        }))
                      }
                    />
                    {channel === 'inApp' ? 'In-app' : channel === 'email' ? 'Email' : 'Slack'}
                  </Label>
                ))}
              </fieldset>
              <Group>
                {groups.map((group) => (
                  <Disclosure
                    className="border-b border-border last:border-0"
                    key={group}
                    defaultOpen={group === 'reviews'}
                  >
                    <DisclosureTrigger className="px-5 py-4 text-ui-lg font-medium capitalize">
                      {group}
                    </DisclosureTrigger>
                    <DisclosureContent>
                      <div className="overflow-x-auto px-5 pb-4">
                        <Table className="w-full text-left text-sm">
                          <TableHeader>
                            <TableRow>
                              <TableHead scope="col" className="pb-3 font-medium">
                                Activity
                              </TableHead>
                              {['In-app', 'Email', 'Slack'].map((channel) => (
                                <TableHead
                                  scope="col"
                                  className="px-3 pb-3 font-medium"
                                  key={channel}
                                >
                                  {channel}
                                </TableHead>
                              ))}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {settings.catalogue
                              .filter((event) => event.group === group)
                              .map((event) => (
                                <TableRow className="border-t border-border" key={event.id}>
                                  <TableHead
                                    scope="row"
                                    className="py-3 pr-4 font-normal whitespace-normal"
                                  >
                                    {event.label}
                                    {event.restricted ? (
                                      <span className="mt-1 block text-xs text-muted-foreground">
                                        Private to recipients
                                      </span>
                                    ) : null}
                                  </TableHead>
                                  {(['inApp', 'email', 'slack'] as const).map((channel) => (
                                    <TableCell className="px-3 py-3" key={channel}>
                                      <Checkbox
                                        aria-label={`${event.label}: workspace ${channel === 'inApp' ? 'in-app' : channel}`}
                                        disabled={
                                          !!busy ||
                                          !policy.availability[channel] ||
                                          (channel === 'slack' && event.restricted)
                                        }
                                        checked={policy.events[event.id]?.[channel] ?? false}
                                        onCheckedChange={(checked) =>
                                          setPolicy((current) => ({
                                            ...current,
                                            events: {
                                              ...current.events,
                                              [event.id]: {
                                                ...current.events[event.id],
                                                [channel]: checked === true,
                                              },
                                            },
                                          }))
                                        }
                                      />
                                    </TableCell>
                                  ))}
                                </TableRow>
                              ))}
                          </TableBody>
                        </Table>
                      </div>
                    </DisclosureContent>
                  </Disclosure>
                ))}
              </Group>
              <SettingsSaveBar
                dirty={policyDirty}
                busy={busy === 'policy'}
                label="Save workspace policy"
                onSave={() => void save('policy')}
                onDiscard={() => setPolicy(settings.policy)}
              />
            </Section>
          </div>
          <div hidden={panel !== 'delivery'}>
            <Section
              title="Delivery status"
              description="Review failures and reconcile uncertain sends. Confirm delivery only after checking the destination."
            >
              {deliveries.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading deliveries…
                </p>
              ) : deliveries.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {deliveries.error.message}
                </p>
              ) : deliveries.data?.deliveries.length === 0 ? (
                <p className="text-sm text-muted-foreground">No external deliveries yet.</p>
              ) : (
                <Group>
                  {deliveries.data?.deliveries.map((delivery) => (
                    <div className="border-b border-border p-5 last:border-0" key={delivery.id}>
                      <p className="text-ui-lg font-medium">
                        {settings.catalogue.find((event) => event.id === delivery.kind)?.label ??
                          'Test notification'}{' '}
                        · {delivery.channel}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {delivery.status.toLowerCase()}
                        {delivery.failureCode
                          ? ` · ${delivery.failureCode.toLowerCase().replaceAll('_', ' ')}`
                          : ''}
                      </p>
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        Reference: {delivery.id}
                      </p>
                      {['BLOCKED', 'UNCERTAIN', 'DEAD'].includes(delivery.status) ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {(['retry', 'confirm_delivered', 'dismiss'] as const).map((action) => (
                            <Button
                              variant="outline"
                              size="sm"
                              key={action}
                              disabled={!!busy}
                              onClick={() =>
                                void perform(delivery.id, async () => {
                                  await notificationRequest(
                                    identity,
                                    `/deliveries/${encodeURIComponent(delivery.id)}/recover`,
                                    z.object({ recovered: z.boolean() }),
                                    { method: 'POST', body: { action } }
                                  )
                                  await deliveries.refetch()
                                  setSaved('Delivery recovery recorded.')
                                })
                              }
                            >
                              {action === 'retry'
                                ? 'Retry safely'
                                : action === 'confirm_delivered'
                                  ? 'Confirm delivered'
                                  : 'Dismiss'}
                            </Button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </Group>
              )}
            </Section>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Owners and administrators manage workspace channels and Slack connections.
        </p>
      )}
    </fieldset>
  )
}

/** Workspace activity policy and personal preferences use the existing settings surface. */
export function WorkspaceNotifications() {
  const identity = useNotificationIdentity()
  const settings = useQuery({
    queryKey: [...identity.key, 'settings'],
    queryFn: ({ signal }) =>
      notificationRequest(identity, '', notificationSettingsSchema, { signal }),
    enabled: identity.ready,
    refetchOnWindowFocus: false,
  })
  if (!identity.ready || settings.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading notification settings…
      </p>
    )
  if (settings.error)
    return (
      <div role="alert">
        <p className="text-sm text-destructive">{settings.error.message}</p>
        <Button className="mt-4" variant="outline" onClick={() => void settings.refetch()}>
          Retry
        </Button>
      </div>
    )
  return (
    <SettingsForm
      key={`${identity.userId}:${identity.workspaceId}`}
      initial={settings.data}
      identity={identity}
    />
  )
}

function TestDeliveryStatus({
  identity,
  id,
}: {
  identity: ReturnType<typeof useNotificationIdentity>
  id: string
}) {
  const visible = useNotificationPageVisible()
  const status = useQuery({
    queryKey: [...identity.key, 'delivery', id],
    queryFn: ({ signal }) =>
      notificationRequest(
        identity,
        `/deliveries/${encodeURIComponent(id)}`,
        notificationDeliverySchema,
        { signal }
      ),
    refetchInterval: (query) =>
      visible && (!query.state.data || ['PENDING', 'CLAIMED'].includes(query.state.data.status))
        ? 3000
        : false,
    refetchIntervalInBackground: false,
  })
  if (status.error)
    return (
      <p role="alert">
        Could not check the test.{' '}
        <Button type="button" variant="outline" size="sm" onClick={() => void status.refetch()}>
          Retry status check
        </Button>
      </p>
    )
  const result = status.data
  return (
    <p role="status" className="text-sm">
      {!result || ['PENDING', 'CLAIMED'].includes(result.status)
        ? 'Waiting for test delivery…'
        : result.status === 'SUCCEEDED'
          ? 'Test delivered.'
          : `Test ${result.status.toLowerCase()}: ${result.failureCode.replaceAll('_', ' ').toLowerCase()}.`}{' '}
      <span className="block text-xs text-muted-foreground">Reference: {id}</span>
    </p>
  )
}
