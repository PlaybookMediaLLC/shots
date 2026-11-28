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
 * Promoted Email Preferences card:
 * - Master email switch (saves with the notification preferences bar below)
 * - Automation emails, Post failure alerts, and Post summary emails (save immediately)
 */
export function EmailSwitch({
  checked,
  disabled,
  onCheckedChange,
}: {
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const { preferences, save, status } = usePreferences()
  const [automationState, runAutomation] = useSaveState()
  const [failureState, runFailure] = useSaveState()
  const [summaryState, runSummary] = useSaveState()
  const ready = status === 'ready' && preferences !== null

  return (
    <Group>
      <Row
        description="Off, no activity email reaches you from any workspace. Sign-in, invitation and security email still arrive."
        label="Email notifications"
      >
        <Switch
          aria-label="Email notifications"
          checked={checked}
          disabled={disabled || status !== 'ready'}
          onCheckedChange={onCheckedChange}
        />
      </Row>
      <Row
        description="Receive helpful reminders about quiet queues, unscheduled drafts, and workspace automations. Includes a one-click unsubscribe link in every message."
        label={
          <span className="flex items-center gap-2">
            Automation emails <SaveStatus state={automationState} />
          </span>
        }
      >
        <Switch
          aria-label="Automation emails"
          checked={preferences?.automationEmails ?? true}
          disabled={!ready}
          onCheckedChange={(automationEmails) =>
            void runAutomation(() => save({ automationEmails }))
          }
        />
      </Row>
      <Row
        description="Receive an email alert whenever a scheduled post fails to publish or needs attention. In-app alerts always remain on."
        label={
          <span className="flex items-center gap-2">
            Post failure alerts <SaveStatus state={failureState} />
          </span>
        }
      >
        <Switch
          aria-label="Post failure alerts"
          checked={preferences?.postFailureAlerts ?? true}
          disabled={!ready}
          onCheckedChange={(postFailureAlerts) =>
            void runFailure(() => save({ postFailureAlerts }))
          }
        />
      </Row>
      <Row
        description="Receive a single combined email summarizing published and failed platforms once all destinations for a post finish settling."
        label={
          <span className="flex items-center gap-2">
            Post summary emails <SaveStatus state={summaryState} />
          </span>
        }
      >
        <Switch
          aria-label="Post summary emails"
          checked={preferences?.postSummaryEmails ?? false}
          disabled={!ready}
          onCheckedChange={(postSummaryEmails) =>
            void runSummary(() => save({ postSummaryEmails }))
          }
        />
      </Row>
      {!checked ? (
        <p className="px-5 pb-4 text-xs text-muted-foreground" role="status">
          Master email notifications are turned off, so activity emails (including post failure
          alerts and post summaries) are paused until you turn them back on.
        </p>
      ) : null}
      {status === 'error' ? (
        <p className="px-5 pb-4 text-sm text-red-700 dark:text-red-300" role="alert">
          Your email settings could not be loaded. Reload the page to try again.
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
        <h3 className="text-ui-lg font-medium text-foreground">By profile</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose each channel independently. These choices override publishing defaults for this
          set. A private set&apos;s activity reaches only its owner. Workspace rules and your email
          switch still apply. You can edit choices while delivery is paused.
        </p>
      </div>
      {sets.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading profiles…
        </p>
      ) : isPlanRefusal(sets.error) ? (
        <PlanRequired from="/settings/notifications">
          Profiles, and notifications for each, need Pro.
        </PlanRequired>
      ) : sets.isError ? (
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">
          {settingsErrorMessage(sets.error)}
        </p>
      ) : sets.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No profiles yet.</p>
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
