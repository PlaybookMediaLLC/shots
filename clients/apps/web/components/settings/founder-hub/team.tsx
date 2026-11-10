import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { SettingsPageTitle } from './page-title'

/** Keep team membership and workspace creation on Shots' existing settings routes. */
export function SettingsTeam() {
  return (
    <div className="grid justify-items-start gap-6">
      <SettingsPageTitle title="Team" />
      <p className="text-sm text-muted-foreground">
        Manage members and create workspaces in Shots settings.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link href="/settings/members">Manage members</Link>
        </Button>
        <Button asChild>
          <Link href="/settings/new-team">Create workspace</Link>
        </Button>
      </div>
    </div>
  )
}
