import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { WorkspaceSettings } from '@/components/workspace/WorkspaceSettings'
import { findFounderHubPage } from '@/components/settings/founder-hub/pages'
import { findSettingsSection, findSocialSetPage } from '@/components/workspace/settings-sections'
import { MCP_URL } from '@/lib/agents/mcp-clients'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { getLocalizedPath, getPageAccess } from '@/lib/auth/page-access'

type WorkspacePageProps = {
  params: Promise<{ locale: string; section?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** Release automation moved to Workflows; old links and GitHub returns keep working. */
const MOVED_SECTIONS: Record<string, string> = { 'release-automation': '/workflows' }

export async function generateMetadata({ params }: WorkspacePageProps): Promise<Metadata> {
  const { section } = await params
  const found = findSettingsSection(section?.[0])
  return { title: `${found?.title ?? 'Settings'} · Settings` }
}

/**
 * The section a path names. Every section is one segment, except a social
 * set's settings: /settings/publishing-brands/{id}/{page}.
 */
function resolveSection(segments: string[] | undefined) {
  const section = findSettingsSection(segments?.[0])
  if (section?.id === 'founder-hub') {
    const founderHubPage = findFounderHubPage(segments?.[1])
    return founderHubPage && (!segments || segments.length <= 2)
      ? { section, founderHubPage }
      : null
  }
  if (!section || !segments || segments.length <= 1) return section ? { section } : null
  if (section.id !== 'social-sets' || segments.length > 3) return null
  const page = findSocialSetPage(segments[2])
  return page && /^[a-z0-9]{10,32}$/.test(segments[1] ?? '')
    ? { page, section, socialSetId: segments[1]! }
    : null
}

export default async function WorkspacePage({ params, searchParams }: WorkspacePageProps) {
  const [{ locale, section: segments }, requestHeaders] = await Promise.all([params, headers()])
  const moved = segments?.length === 1 ? MOVED_SECTIONS[segments[0]] : undefined
  if (moved) {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(await searchParams)) {
      for (const item of [value ?? []].flat()) query.append(key, item)
    }
    redirect(getLocalizedPath(locale, query.size ? `${moved}?${query}` : moved))
  }
  const resolved = resolveSection(segments)
  if (!resolved) notFound()
  const access = await getPageAccess(requestHeaders)
  if (!access) redirect(getLocalizedPath(locale, '/sign-in'))
  if (!access.hasOrganization || !access.organization) {
    redirect(getLocalizedPath(locale, '/onboarding'))
  }

  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <WorkspaceSettings
        deniedPermissions={access.deniedPermissions}
        draftsEnabled={contentDraftsEnabled()}
        email={access.session.user.email}
        mcpUrl={MCP_URL}
        name={access.session.user.name || ''}
        organization={access.organization}
        role={access.role}
        section={resolved.section.id}
        founderHubPage={resolved.founderHubPage}
        socialSet={
          resolved.socialSetId ? { id: resolved.socialSetId, page: resolved.page } : undefined
        }
        twoFactorEnabled={Boolean(access.session.user.twoFactorEnabled)}
        userId={access.session.user.id}
      />
    </PlatformShell>
  )
}
