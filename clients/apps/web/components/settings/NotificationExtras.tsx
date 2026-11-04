'use client'

import { Group, PlanRequired, Row } from '@/components/platform-ui'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import { useSocialSets } from '@/components/settings/social-sets/api'
import { NotificationPreferenceTable } from '@/components/settings/NotificationPreferenceTable'
import { socialSetPreferenceEvents } from '@/lib/notifications/preferences'
import type { NotificationSettings } from '@/lib/notifications/schema'
import { Switch } from '@/components/ui/switch'
import { isPlanRefusal } from '@/lib/api/platform-errors'
import { SettingsRequestError, settingsErrorMessage } from '@/lib/settings/client'

/**
 * The email master switch (RFC 024). It is a personal preference, so it holds
 * in every workspace; off, no activity email reaches you, while sign-in,
 * invitation and security messages still do.
 */
export function EmailSwitch() {
  const { preferences, save, status } = usePreferences()
  const [state, run] = useSaveState()
  return (
    <Group>
      <Row
        description="Off, no activity email reaches you from any workspace. Sign-in, invitation and security email still arrive."
        label="Email notifications"
      >
        <div className="flex items-center gap-3">
          <SaveStatus state={state} />
          <Switch
            aria-label="Email notifications"
            checked={preferences?.emailNotifications ?? true}
            disabled={status !== 'ready'}
            onCheckedChange={(emailNotifications) => void run(() => save({ emailNotifications }))}
          />
        </div>
      </Row>
      {status === 'error' ? (
        <p className="px-5 pb-4 text-sm text-red-700 dark:text-red-300" role="alert">
          Your email setting could not be loaded. Reload the page to try again.
        </p>
      ) : null}
    </Group>
  )
}

/** Publishing choices are saved with the member's other notification preferences. */
export function SocialSetNotifications({
  disabled,
  onChange,
  value,
  settings,
  emailEnabled,
}: {
  disabled: boolean
  onChange: (next: NotificationSettings['preferences']) => void
  value: NotificationSettings['preferences']
  settings: NotificationSettings
  emailEnabled: boolean
}) {
  const sets = useSocialSets()
  if (sets.error instanceof SettingsRequestError && sets.error.status === 404) return null
  return (
    <div className="grid gap-3">
      <div>
        <h3 className="text-ui-lg font-medium text-foreground">By publishing brand</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose each channel independently. These choices override publishing defaults for this
          set. A private set&apos;s activity reaches only its owner. Workspace rules and your email
          switch still apply. You can edit choices while delivery is paused.
        </p>
      </div>
      {sets.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading publishing brands…
        </p>
      ) : isPlanRefusal(sets.error) ? (
        <PlanRequired from="/workspace/notifications">
          Publishing brands, and notifications for each, need Pro.
        </PlanRequired>
      ) : sets.isError ? (
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">
          {settingsErrorMessage(sets.error)}
        </p>
      ) : sets.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No publishing brands yet.</p>
      ) : (
        <Group>
          {sets.data.items.map((set) => (
            <fieldset
              className="min-w-0 border-b border-border px-5 py-4 last:border-0"
              disabled={disabled}
              key={set.id}
              aria-label={`${set.name} (${set.id}) notification preferences`}
            >
              <legend className="flex items-center gap-2 text-ui-lg font-medium">
                <span
                  aria-hidden
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: set.color }}
                />
                {set.name}
              </legend>
              <p className="mb-3 text-xs text-muted-foreground">
                {set.visibility === 'PRIVATE' ? 'Private to you' : 'Shared with workspace'}
                {' · '}
                {set.accounts
                  .map((account) => account.handle || account.displayName || account.platform)
                  .join(', ') || 'No connected accounts'}
                {' · '}Set {set.id}
              </p>
              <NotificationPreferenceTable
                events={socialSetPreferenceEvents}
                group="publishing activity"
                context={`${set.name} (${set.id})`}
                setId={set.id}
                value={value}
                onChange={onChange}
                settings={settings}
                emailEnabled={emailEnabled}
              />
            </fieldset>
          ))}
        </Group>
      )}
    </div>
  )
}
