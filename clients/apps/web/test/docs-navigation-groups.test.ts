import assert from 'node:assert/strict'
import test from 'node:test'
import { getDocsNavigationGroups, sectionContainsPath } from '../lib/docs/navigation-groups'
import { filterDocsPages, type DocsSearchEntry } from '../lib/docs/search-filter'

const documents = [
  { slug: 'features/campaigns', title: 'Campaigns' },
  { slug: 'features/publish', title: 'Publish' },
  { slug: 'features/settings-workspace', title: 'Workspace Settings' },
] as const

const toExpectedEntry = (document: (typeof documents)[number]) => ({
  title: document.title,
  url: `/docs/${document.slug}`,
})

test('getDocsNavigationGroups uses section headings and list links as navigation groups', () => {
  const content = [
    '## Launches & Publishing',
    '',
    '- [Campaigns](/docs/features/campaigns)',
    '- [Publish](/docs/features/publish)',
    '',
    '## Workspace Settings',
    '',
    '- [Workspace Settings](/docs/features/settings-workspace)',
  ].join('\n')

  assert.deepEqual(getDocsNavigationGroups(content, documents), [
    { items: documents.slice(0, 2).map(toExpectedEntry), title: 'Launches & Publishing' },
    { items: [toExpectedEntry(documents[2])], title: 'Workspace Settings' },
  ])
})

test('getDocsNavigationGroups handles undefined index, duplicates, pre-heading links, empty groups, and unknown links', () => {
  assert.deepEqual(getDocsNavigationGroups(undefined, documents), [
    { items: documents.map(toExpectedEntry), title: 'More' },
  ])

  const trickyContent = [
    '- [Campaigns](/docs/features/campaigns)',
    '## Empty Heading',
    '## Launches',
    '- [Campaigns](/docs/features/campaigns)',
    '- [Duplicate Campaigns](/docs/features/campaigns)',
    '- [Unknown](/docs/features/does-not-exist)',
    '- [External](https://example.com)',
  ].join('\n')

  assert.deepEqual(getDocsNavigationGroups(trickyContent, documents), [
    { items: [toExpectedEntry(documents[0])], title: 'Launches' },
    { items: documents.slice(1).map(toExpectedEntry), title: 'More' },
  ])
})

test('sectionContainsPath matches section overview URLs and nested grouped entries', () => {
  const section = {
    groups: [{ items: [{ title: 'Campaigns', url: '/docs/features/campaigns' }], title: 'Core' }],
    url: '/docs/features',
  }
  assert.equal(sectionContainsPath(section, '/docs/features'), true)
  assert.equal(sectionContainsPath(section, '/docs/features/campaigns'), true)
  assert.equal(sectionContainsPath(section, '/docs/guides'), false)
})

test('filterDocsPages orders all 7 relevance tiers with stable tie-breaking and case-insensitivity', () => {
  const makeEntry = (overrides: Partial<DocsSearchEntry> & Pick<DocsSearchEntry, 'id'>) => ({
    category: 'Documentation',
    contentType: 'documentation' as const,
    description: 'General summary',
    excerpt: 'General excerpt',
    keywords: [],
    title: 'Unrelated Page',
    url: `/docs/${overrides.id}`,
    ...overrides,
  })

  const pages: DocsSearchEntry[] = [
    makeEntry({ id: 'rank6-keyword', keywords: ['contains webhook payload details'] }),
    makeEntry({ id: 'rank5-category', category: 'Webhook Guides' }),
    makeEntry({ id: 'rank4-desc', description: 'Configure webhook signatures safely.' }),
    makeEntry({ id: 'rank3-url', url: '/docs/api/webhook-events' }),
    makeEntry({ id: 'rank2-title-sub', title: 'Outbound Webhook Signing' }),
    makeEntry({ id: 'rank1-title-prefix', title: 'Webhook Delivery Guide' }),
    makeEntry({ id: 'rank0-title-exact', title: 'Webhook' }),
    makeEntry({ id: 'rank2-tie-second', title: 'Inbound Webhook Verification' }),
  ]

  const ranked = filterDocsPages(pages, 'WEBHOOK')
  assert.deepEqual(
    ranked.map((page) => page.id),
    [
      'rank0-title-exact',
      'rank1-title-prefix',
      'rank2-title-sub',
      'rank2-tie-second',
      'rank3-url',
      'rank4-desc',
      'rank5-category',
      'rank6-keyword',
    ]
  )
  assert.equal(filterDocsPages(pages, '   ').length, pages.length)
  assert.equal(filterDocsPages(pages, 'nonexistent-query-xyz').length, 0)
})
