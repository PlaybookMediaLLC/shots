import { SETTINGS_SECTIONS, settingsHref } from '@/components/workspace/settings-sections'
import {
  activeLink,
  AREA_LINKS,
  campaignLinks,
  PLATFORM_DESTINATIONS,
  type PlatformArea,
  publishLinks,
} from '@/lib/platform/navigation'

/** One page Search opens, named with the section it is in ("Deliveries · Campaigns"). */
export type PalettePage = {
  href: string
  label: string
  /** The section's name; empty for a section that is one page, such as Home. */
  section: string
  /** What a search matches: the page's name, and a settings page's extra keywords. */
  terms: string
}

/** Every page of the sections this workspace sees, then every settings page. */
export function palettePages({
  campaignsEnabled,
  draftsEnabled,
  sectionLabel,
}: {
  campaignsEnabled: boolean
  draftsEnabled: boolean
  sectionLabel: (key: PlatformArea) => string
}): PalettePage[] {
  const areas = PLATFORM_DESTINATIONS.filter(
    (item) => item.key !== 'settings' && (campaignsEnabled || item.key !== 'campaigns')
  ).flatMap(({ href, key }) => {
    const links =
      key === 'publish'
        ? draftsEnabled
          ? publishLinks()
          : [{ href: '/publish/link-checks', label: 'Link checks' }]
        : key === 'campaigns'
          ? campaignLinks(draftsEnabled)
          : AREA_LINKS[key]
    return links
      ? links.map((link) => ({ ...link, section: sectionLabel(key), terms: link.label }))
      : [{ href, label: sectionLabel(key), section: '', terms: sectionLabel(key) }]
  })
  const settings = SETTINGS_SECTIONS.filter((section) => section.id !== 'new-team').map(
    (section) => ({
      href: settingsHref(section),
      label: section.title,
      section: sectionLabel('settings'),
      terms: `${section.title} ${section.keywords ?? ''}`,
    })
  )
  return [...areas, ...settings]
}

/** The pages a search names, by page name or settings keyword. */
export function searchPages(pages: readonly PalettePage[], query: string): PalettePage[] {
  const search = query.trim().toLowerCase()
  return search ? pages.filter((page) => page.terms.toLowerCase().includes(search)) : []
}

/** The known pages among visited addresses (without their locale), newest first, once each. */
export function visitedPages(
  pages: readonly PalettePage[],
  visits: readonly string[]
): PalettePage[] {
  const found = visits.flatMap((visit) => {
    const [path = '', query = ''] = visit.split('?')
    const page = activeLink(pages, path, new URLSearchParams(query))
    return page ? [page] : []
  })
  return found.filter((page, index) => found.findIndex((item) => item.href === page.href) === index)
}
