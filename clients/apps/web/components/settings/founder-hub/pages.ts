/** Original settings destinations; aliases preserve existing desktop deep links. */
export const FOUNDER_HUB_PAGES = [
  { id: 'general', title: 'General', group: 'App' },
  { id: 'appearance', title: 'Appearance', group: 'App' },
  { id: 'notifications', title: 'Notifications', group: 'App' },
  { id: 'dictionary', title: 'Dictionary', group: 'AI' },
  { id: 'dictation', title: 'Dictation', group: 'AI' },
  { id: 'intelligence', title: 'Intelligence', group: 'AI' },
  { id: 'transcription', title: 'Transcription', group: 'AI' },
  { id: 'automations', title: 'Automations', group: 'Workspace' },
  { id: 'sync', title: 'Sync', group: 'Workspace' },
  { id: 'todo', title: 'Ticket', group: 'Workspace' },
  { id: 'meetings', title: 'Meetings', group: 'Workspace' },
  { id: 'templates', title: 'Templates', group: 'Workspace' },
  { id: 'privacy', title: 'Privacy', group: 'Advanced' },
  { id: 'permissions', title: 'Permissions', group: 'Advanced' },
] as const

export type FounderHubPage = (typeof FOUNDER_HUB_PAGES)[number]['id']

/** Resolve a nested settings URL without silently substituting an unrelated page. */
export function findFounderHubPage(value?: string): FounderHubPage | undefined {
  const aliases: Record<string, string> = {
    app: 'general',
    audio: 'meetings',
    personalization: 'dictionary',
  }
  const requested = value ? (aliases[value] ?? value) : 'general'
  return FOUNDER_HUB_PAGES.find((page) => page.id === requested)?.id
}
