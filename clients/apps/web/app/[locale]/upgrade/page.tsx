import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { CheckIcon as Check } from '@/components/platform-shell/icons'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Group, Page, Row } from '@/components/platform-ui'
import { getLocalizedPath, getPageAccess } from '@/lib/auth/page-access'
import { accessAllows } from '@/lib/auth/permissions'
import { paidCapability, safeReturnPath } from '@/lib/platform/navigation'

export const metadata = { title: 'Plans' }

const INCLUDED = [
  'Publish: drafts, threads and previews',
  'Calendar and scheduled posts',
  'Link checks',
  'Create: screenshot, store and Canvas editors',
  'Library, templates and brand kit',
  'Campaigns, Automate and Activity',
]

/**
 * Where a signed-in workspace lands when it asks for a paid capability. Unlike
 * the public pricing page it keeps the app around the person, names what they
 * asked for, and says what a plan includes.
 */
export default async function UpgradePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ from?: string | string[] }>
}) {
  const [{ locale }, { from }] = await Promise.all([params, searchParams])
  const requested = safeReturnPath(typeof from === 'string' ? from : null, '')
  const access = await getPageAccess(await headers())
  if (!access) {
    const self = requested ? `/upgrade?from=${encodeURIComponent(requested)}` : '/upgrade'
    redirect(getLocalizedPath(locale, `/sign-in?callbackURL=${encodeURIComponent(self)}`))
  }
  if (!access.hasOrganization) redirect(getLocalizedPath(locale, '/onboarding'))
  if (!access.isWorkspaceOperational) redirect(getLocalizedPath(locale, '/settings'))
  // A plan bought in another tab, or a stale link: go where they were headed.
  if (access.hasPaidPlan) redirect(getLocalizedPath(locale, requested || '/home'))

  const capability = paidCapability(requested)
  const workspace = access.organization?.name ?? 'This workspace'
  const canManage = accessAllows(access, 'billing:manage')
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <Page
        title={capability ? `${capability} is on Pro` : 'Choose a plan'}
        description={`${workspace} has no plan yet. Choose Pro or Business to start using Shots.`}
        width="md"
      >
        <Group>
          <Row>
            <section aria-label="Pro and Business">
              <h2 className="text-sm text-foreground">Pro and Business</h2>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {INCLUDED.map((item) => (
                  <li key={item} className="flex gap-2 text-sm text-muted-foreground">
                    <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-primary" />
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          </Row>
          <Row>
            <div className="flex flex-wrap items-center gap-3">
              {canManage ? (
                // Straight to plan choice. What they asked for travels through Checkout
                // and opens once they pay; without it, onboarding or the app opens as before.
                <ButtonLink
                  href={requested ? `/pricing?returnTo=${encodeURIComponent(requested)}` : '/pricing'}
                >
                  Choose a plan
                </ButtonLink>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    An owner or billing admin of {workspace} can upgrade it.
                  </p>
                  <ButtonLink href="/pricing" variant="outline">
                    Compare plans
                  </ButtonLink>
                </>
              )}
            </div>
          </Row>
        </Group>
      </Page>
    </PlatformShell>
  )
}
