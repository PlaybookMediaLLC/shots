/**
 * Settings sections, each its own route under /settings; shared by the
 * settings sidebar, the page and its content map (RFC 024). Sections are
 * grouped by who owns what they change: the person, the workspace, or a
 * publishing identity (a brand).
 *
 * To add a section, add it here. TypeScript then asks for its icon in
 * `SettingsNav.tsx` and its content in `WorkspaceSettingDetail.tsx`.
 */

import { z } from 'zod'

/** Who a section's settings belong to. */
export const settingGroupSchema = z.enum([
  'personal',
  'workspace',
  'brand',
  'publishing',
  'integrations',
  'advanced',
])

/** One of {@link settingGroupSchema}'s values. */
export type SettingGroup = z.infer<typeof settingGroupSchema>

type SettingSectionDefinition = {
  description: string
  group: SettingGroup
  id: string
  /** Extra search terms the settings search matches but the page does not show. */
  keywords?: string
  /** URL segment under /settings; General lives at /settings itself. */
  slug: string
  title: string
}

/** Group headings, in display order. */
export const SETTING_GROUPS: { id: SettingGroup; title: string }[] = [
  { id: 'personal', title: 'My account' },
  { id: 'workspace', title: 'Workspace & team' },
  { id: 'brand', title: 'Brand resources & content' },
  { id: 'publishing', title: 'Publishing' },
  { id: 'integrations', title: 'Integrations' },
  { id: 'advanced', title: 'Advanced' },
]

/** Every section, in the order the navigation lists them within their group. */
const SECTIONS = [
  {
    description: 'Your profile, sign-in email, time zone, sessions, and account deletion.',
    group: 'personal',
    id: 'profile',
    slug: 'account',
    title: 'Account',
  },
  {
    description: 'Activity preferences, delivery channels, and Slack notifications.',
    group: 'personal',
    id: 'notifications',
    slug: 'notifications',
    title: 'Notifications',
  },
  {
    description: 'Theme, navigation, calendar, and editor direction.',
    group: 'personal',
    id: 'appearance',
    slug: 'appearance',
    title: 'Appearance',
  },
  {
    description: 'Two-factor authentication and session controls.',
    group: 'personal',
    id: 'security',
    slug: 'security',
    title: 'Security',
  },
  {
    description: 'Use Shots as an app on your computer or phone.',
    group: 'personal',
    id: 'install',
    slug: 'install',
    title: 'Install',
  },
  {
    description: 'Workspace name, slug, logo, time zone, release preferences, and defaults.',
    group: 'workspace',
    id: 'general',
    keywords: 'timezone',
    slug: '',
    title: 'General',
  },
  {
    description: 'Your plan, billing status, and AI credits.',
    group: 'workspace',
    id: 'billing',
    slug: 'billing',
    title: 'Billing',
  },
  {
    description: 'Invite, manage, and remove workspace members.',
    group: 'workspace',
    id: 'members',
    slug: 'members',
    title: 'Members',
  },
  {
    description: 'Workspace roles and least-privilege permissions.',
    group: 'workspace',
    id: 'roles',
    slug: 'roles',
    title: 'Roles',
  },
  {
    description: 'Start a separate workspace for a team, project, or client.',
    group: 'workspace',
    id: 'new-team',
    slug: 'new-team',
    title: 'Create workspace',
  },
  {
    description: 'Brand voice for AI copy, plus colors and typography for visuals.',
    group: 'brand',
    id: 'brand',
    slug: 'brand-kit',
    title: 'Brand voice & visual kits',
  },
  {
    description: 'What your product is, who it is for, and what campaigns can claim.',
    group: 'brand',
    id: 'product',
    slug: 'product',
    title: 'Product',
  },
  {
    description: 'The product pages campaigns screenshot, and how fresh each capture is.',
    group: 'brand',
    id: 'surfaces',
    slug: 'product-pages',
    title: 'Product pages',
  },
  {
    description: 'Every design published at a link: copy, restrict, or revoke.',
    group: 'publishing',
    id: 'sharing',
    slug: 'shared-links',
    title: 'Shared links',
  },
  {
    description:
      'The people and brands you post as: their accounts, schedules, defaults, and voice.',
    group: 'publishing',
    id: 'social-sets',
    slug: 'publishing-brands',
    title: 'Publishing brands',
  },
  {
    description: 'Manage the social accounts this workspace posts from, and the publishing brand each belongs to.',
    group: 'publishing',
    id: 'channels',
    slug: 'channels',
    title: 'Channels',
  },
  {
    description: 'Every agent and app Shots connects to, what each needs, and how to set it up.',
    group: 'integrations',
    id: 'integrations',
    slug: 'integrations',
    title: 'Integrations',
  },
  {
    description: 'Connect Claude, ChatGPT, Cursor, and other AI agents to this workspace over MCP.',
    group: 'integrations',
    id: 'agents',
    slug: 'ai-agents',
    title: 'AI agents',
  },
  {
    description: 'Single sign-on and SCIM provisioning controls.',
    group: 'advanced',
    id: 'sso',
    slug: 'sso',
    title: 'SSO',
  },
  {
    description: 'Restrict what groups of members may do, beyond their roles.',
    group: 'advanced',
    id: 'permission-groups',
    keywords: 'access control restrict deny',
    slug: 'permission-groups',
    title: 'Permission groups',
  },
  {
    description: 'Your name, logo and colors in the signed-in app.',
    group: 'advanced',
    id: 'whitelabel',
    keywords: 'branding logo favicon theme colors',
    slug: 'white-label',
    title: 'White label',
  },
  {
    description: 'Searchable events, retention, and SIEM log drains.',
    group: 'advanced',
    id: 'audit',
    slug: 'audit-log',
    title: 'Audit log',
  },
  {
    description: 'API keys, outbound webhooks, development mode, and debug logs.',
    group: 'advanced',
    id: 'api',
    slug: 'developers',
    title: 'Developer API',
  },
  {
    description: 'Try features before they ship to everyone.',
    group: 'advanced',
    id: 'experimental',
    slug: 'experimental',
    title: 'Experimental',
  },
] as const satisfies readonly SettingSectionDefinition[]

/** A section's stable id, from {@link SETTINGS_SECTIONS}. */
export type SettingId = (typeof SECTIONS)[number]['id']

export type SettingSection = SettingSectionDefinition & { id: SettingId }

export const SETTINGS_SECTIONS: readonly SettingSection[] = SECTIONS

/** The pages of one brand's settings, in display order. */
export const SOCIAL_SET_PAGES = [
  { slug: 'general', title: 'General' },
  { slug: 'scheduling', title: 'Scheduling' },
  { slug: 'new-draft', title: 'New draft' },
  { slug: 'public-profile', title: 'Public profile' },
  { slug: 'writing-assistant', title: 'Writing Assistant' },
] as const

/** One of {@link SOCIAL_SET_PAGES}' slugs. */
export type SocialSetPage = (typeof SOCIAL_SET_PAGES)[number]['slug']

export function settingsHref(section: SettingSection): string {
  return section.slug ? `/settings/${section.slug}` : '/settings'
}

/** The address of one brand's settings page. */
export function socialSetHref(id: string, page: SocialSetPage = 'general'): string {
  return `/settings/publishing-brands/${encodeURIComponent(id)}${page === 'general' ? '' : `/${page}`}`
}

export function findSettingsSection(slug: string | undefined): SettingSection | undefined {
  return SETTINGS_SECTIONS.find((section) => section.slug === (slug ?? ''))
}

/**
 * The section a pathname shows, from its first segment under /settings, so a
 * brand's own pages light Publishing brands. Pass the pathname without a locale.
 */
export function settingsSectionAt(pathname: string): SettingSection | undefined {
  const [area, slug] = pathname.split('/').filter(Boolean)
  return area === 'settings' ? findSettingsSection(slug) : undefined
}

/** A brand settings page by its slug; General when omitted. */
export function findSocialSetPage(slug: string | undefined): SocialSetPage | undefined {
  return SOCIAL_SET_PAGES.find((page) => page.slug === (slug ?? 'general'))?.slug
}
