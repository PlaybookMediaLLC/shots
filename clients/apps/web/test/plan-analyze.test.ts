import assert from 'node:assert/strict'
import test from 'node:test'
import { analyticsReportSchema, analyticsQuerySchema } from '../lib/api/contracts/plan-analyze'
import { draftPlanInputSchema } from '../lib/api/contracts/write'
import {
  draftPostsState,
  OVERDUE_AFTER_MS,
  POST_STATE_TONE,
  postFailureReason,
  postState,
  STATUS_GROUPS,
} from '../lib/content-drafts/post-status'
import {
  displayDaySlots,
  calendarDays,
  shiftAnchor,
  validDay,
  planPreferencesSchema,
  selectionState,
  selectedInstant,
  visibleDayItems,
  visibleItems,
  itemDay,
  movedToDay,
  takenSlots,
  weekCardLayout,
  type PlanItem,
} from '../lib/plan/calendar'
import {
  readAnalyticsReport,
  chartCSV,
  chartPoints,
  csv,
  formatValue,
  initialQuery,
  postsCSV,
  presetRange,
  PRESETS,
} from '../lib/analyze/report'

const point = (at: string, value: number | null) => ({ at, value, samples: value === null ? 0 : 1 })
const metric = {
  status: 'available',
  value: 0,
  previous: null,
  change: null,
  points: [point('2026-03-01', 0)],
  definition: 'Actual observations',
  samples: 1,
  missing: 0,
}
const report = () =>
  analyticsReportSchema.parse({
    accountId: 'account-one',
    name: 'Same name',
    platform: 'x',
    profileUrl: 'https://x.com/example',
    query: { from: '2026-03-01', to: '2026-03-31', timeZone: 'America/New_York' },
    status: 'available',
    capabilities: { account: true, posts: true, import: true },
    checkedAt: null,
    coverageStart: null,
    asOf: '2026-04-01T00:00:00Z',
    metrics: { followers: metric },
    posts: [],
    totalPosts: 0,
    nextCursor: null,
    hourly: [],
    settings: { version: 1, goal: null, publicToken: null },
    progress: { streak: 0, current: 0, required: 1, period: '2026-03-31' },
  })
const items: PlanItem[] = [
  {
    id: 'one',
    draftId: 'draft1',
    version: 1,
    calendarVersion: 1,
    setId: 'set-x',
    platform: 'x',
    at: '2026-04-01T01:30:00Z',
    zone: 'UTC',
    status: 'Planned',
    title: 'Same name',
    text: 'X text',
    tagIds: ['tag-x'],
  },
  {
    id: 'two',
    draftId: 'draft2',
    version: 2,
    calendarVersion: 1,
    setId: 'set-li',
    platform: 'linkedin',
    at: '2026-04-01T01:30:00Z',
    zone: 'Asia/Tokyo',
    status: 'Published',
    title: 'Same name',
    text: 'LinkedIn text',
    tagIds: ['tag-li'],
  },
]

test('P36 legacy plan request shape stays compatible without inventing a current revision', () => {
  const legacy = { plannedFor: '2027-01-02T12:00:00Z', timeZone: 'UTC' }
  assert.equal(draftPlanInputSchema.parse(legacy).baseCalendarVersion, undefined)
  assert.equal(
    draftPlanInputSchema.parse({ ...legacy, baseCalendarVersion: 4 }).baseCalendarVersion,
    4
  )
  assert.equal(draftPlanInputSchema.safeParse({ ...legacy, baseCalendarVersion: 0 }).success, false)
})

test('P02/P03 identical names retain stable provider and set identity in all-account results', () => {
  const result = visibleItems(items, planPreferencesSchema.parse({}))
  assert.deepEqual(
    result.map((i) => [i.id, i.setId, i.platform]),
    [
      ['one', 'set-x', 'x'],
      ['two', 'set-li', 'linkedin'],
    ]
  )
})
test('P04 focus and return to all preserve the source item identities', () => {
  assert.deepEqual(
    visibleItems(items, planPreferencesSchema.parse({ visible: ['set-li'] })).map((i) => i.id),
    ['two']
  )
  assert.equal(visibleItems(items, planPreferencesSchema.parse({ visible: null })).length, 2)
})
test('P05 group selection distinguishes all, none, mixed, and removed sets', () => {
  assert.equal(selectionState(null, ['a', 'b']), 'all')
  assert.equal(selectionState([], ['a', 'b']), 'none')
  assert.equal(selectionState(['a'], ['a', 'b']), 'mixed')
  assert.equal(selectionState(['removed'], ['a', 'b']), 'none')
})
test('P06 arbitrary visibility subsets never fall back to all on an empty selection', () => {
  assert.deepEqual(visibleItems(items, planPreferencesSchema.parse({ visible: [] })), [])
  assert.equal(
    visibleItems(items, planPreferencesSchema.parse({ visible: ['set-x'] }))[0].id,
    'one'
  )
})
test('P10 Flex exposes exactly its requested viewport weeks', () => {
  for (const weeks of [1, 2, 4, 8])
    assert.equal(calendarDays('2026-04-01', 'flex', 1, weeks).length, weeks * 7)
})
test('P11 month includes adjacent dates and leap-year February', () => {
  assert.deepEqual(
    [calendarDays('2026-03-15', 'month', 1)[0], calendarDays('2026-03-15', 'month', 1).at(-1)],
    ['2026-02-23', '2026-04-05']
  )
  assert.ok(calendarDays('2028-02-15', 'month', 0).includes('2028-02-29'))
})
test('P12 week is exactly seven consecutive dates across year boundaries', () => {
  assert.deepEqual(calendarDays('2027-01-01', 'week', 1), [
    '2026-12-28',
    '2026-12-29',
    '2026-12-30',
    '2026-12-31',
    '2027-01-01',
    '2027-01-02',
    '2027-01-03',
  ])
})
test('P13 all views contain their anchor without mutating it', () => {
  for (const view of ['flex', 'month', 'week'] as const)
    assert.ok(calendarDays('2026-12-31', view, 1).includes('2026-12-31'))
})
test('P12 overlapping weekly cards remain separate and reuse lanes only after a card ends', () => {
  const near = { ...items[0], id: 'near', at: '2026-04-01T02:00:00Z' }
  const later = { ...items[0], id: 'later', at: '2026-04-01T03:34:00Z' }
  const input = [later, items[1], near, items[0]]
  const layout = weekCardLayout(input, 'UTC', 120)
  assert.equal(layout.lanes, 3)
  assert.deepEqual(
    layout.cards.map(({ item, top, lane }) => [item.id, top, lane]),
    [
      ['one', 90, 0],
      ['two', 90, 1],
      ['near', 120, 2],
      ['later', 214, 0],
    ]
  )
  assert.deepEqual(
    input.map((item) => item.id),
    ['later', 'two', 'near', 'one']
  )
})
test('P12 repeated DST wall-clock times occupy separate weekly lanes', () => {
  const input = [
    { ...items[0], at: '2026-11-01T05:30:00Z' },
    { ...items[1], at: '2026-11-01T06:30:00Z' },
  ]
  const layout = weekCardLayout(input, 'America/New_York', 88)
  assert.equal(layout.lanes, 2)
  assert.deepEqual(
    layout.cards.map(({ top, lane }) => [top, lane]),
    [
      [90, 0],
      [90, 1],
    ]
  )
})
test('P14 navigation increments weeks or clamped calendar months', () => {
  assert.equal(shiftAnchor('2026-01-31', 'month', 1, 3), '2026-02-28')
  assert.equal(shiftAnchor('2026-12-31', 'month', 1, 3), '2027-01-31')
  assert.equal(shiftAnchor('2026-03-01', 'week', -1, 3), '2026-02-22')
  assert.equal(shiftAnchor('2026-03-01', 'flex', 1, 3), '2026-03-22')
})
test('P16 status/platform/tag filters combine without overwriting visibility', () => {
  const prefs = planPreferencesSchema.parse({
    visible: ['set-x', 'set-li'],
    statuses: ['Published'],
    providers: ['linkedin'],
    tagIds: ['tag-li'],
  })
  assert.deepEqual(
    visibleItems(items, prefs).map((i) => i.id),
    ['two']
  )
  assert.deepEqual(prefs.visible, ['set-x', 'set-li'])
  assert.equal(visibleItems(items, { ...prefs, tagIds: ['missing'] }).length, 0)
})
test('P18 week-start preference changes layout, not item instants', () => {
  assert.equal(calendarDays('2026-04-01', 'week', 0)[0], '2026-03-29')
  assert.equal(calendarDays('2026-04-01', 'week', 1)[0], '2026-03-30')
})
test('P22/P23 display zone moves a card across midnight without changing its scheduling zone or UTC instant', () => {
  const before = JSON.stringify(items[0])
  assert.equal(itemDay(items[0], 'America/New_York'), '2026-03-31')
  assert.equal(itemDay(items[0], 'Asia/Tokyo'), '2026-04-01')
  assert.equal(JSON.stringify(items[0]), before)
})
test('P23 a card dropped on another day keeps its own zone clock across a daylight-saving change', () => {
  const now = new Date('2026-03-01')
  // 14:00 London on 25 March (GMT), seen from New York (already on EDT) as 10:00.
  const at = '2026-03-25T14:00:00.000Z'
  // Dropped a week later in the New York display, after London moved to BST:
  // it stays 14:00 London, not 10:00 New York (which would be 15:00 London).
  assert.equal(
    movedToDay(at, 'Europe/London', 'America/New_York', '2026-04-01', now).toISOString(),
    '2026-04-01T13:00:00.000Z'
  )
  // A late-evening post whose display day is the next day moves by displayed days.
  assert.equal(
    movedToDay('2026-03-10T23:30:00.000Z', 'UTC', 'Asia/Tokyo', '2026-03-13', now).toISOString(),
    '2026-03-12T23:30:00.000Z'
  )
  assert.throws(() => movedToDay(at, 'Europe/London', 'UTC', '2026-02-20', now), /future/)
})
test('P19 only posts the queue still holds take their slot', () => {
  const at = '2026-04-02T13:00:00Z'
  const slotItems: PlanItem[] = (
    [
      'Planned',
      'Scheduled',
      'Overdue',
      'Publishing',
      'Needs check',
      'Failed',
      'Published',
      'Cancelled',
    ] as const
  ).map((status, index) => ({ ...items[0], id: `slot-${index}`, setId: 'set-q', at, status }))
  assert.deepEqual(takenSlots([...slotItems, { ...items[0], status: 'Scheduled' }], 'set-q'), [
    at,
    at,
    at,
    at,
  ])
})
test('P30 invalid dates and past instants are rejected', () => {
  assert.equal(validDay('2026-02-30'), false)
  assert.throws(() => selectedInstant('2026-02-30T12:00', 'UTC', 'reject', new Date('2026-01-01')))
  assert.throws(() => selectedInstant('2025-12-31T12:00', 'UTC', 'reject', new Date('2026-01-01')))
})
test('P31 arbitrary minutes remain supported alongside quarter-hour suggestions', () => {
  assert.equal(
    selectedInstant(
      '2026-04-01T12:07',
      'America/New_York',
      'reject',
      new Date('2026-01-01')
    ).toISOString(),
    '2026-04-01T16:07:00.000Z'
  )
})
test('P38 New York skipped and repeated hours require deterministic resolution', () => {
  const now = new Date('2026-01-01')
  assert.throws(
    () => selectedInstant('2026-03-08T02:30', 'America/New_York', 'reject', now),
    /skip/
  )
  assert.throws(
    () => selectedInstant('2026-11-01T01:30', 'America/New_York', 'reject', now),
    /twice/
  )
  assert.equal(
    selectedInstant('2026-11-01T01:30', 'America/New_York', 'earlier', now).toISOString(),
    '2026-11-01T05:30:00.000Z'
  )
  assert.equal(
    selectedInstant('2026-11-01T01:30', 'America/New_York', 'later', now).toISOString(),
    '2026-11-01T06:30:00.000Z'
  )
})
test('A04/A16 unavailable, zero, and negative follower growth retain different values', () => {
  assert.equal(formatValue(0), '0')
  assert.equal(formatValue(null), '—')
  assert.equal(analyticsReportSchema.parse(report()).metrics.followers.value, 0)
  assert.deepEqual(
    chartPoints(
      {
        ...report().metrics.followers,
        points: [point('2026-03-01', 10), point('2026-03-02', 8), point('2026-03-03', null)],
      },
      true
    ).map((p) => p.value),
    [null, -2, null]
  )
})
test('A07 compact presentation preserves full-precision source values', () => {
  assert.equal(formatValue(1234567, true), '1.2M')
  assert.equal(formatValue(1234567), '1,234,567')
})
test('A09 all eleven documented presets are exposed', () => {
  assert.deepEqual(PRESETS, [
    '7 days',
    '14 days',
    '1 month',
    '3 months',
    '6 months',
    '1 year',
    'Current week',
    'Last week',
    'Current month',
    'Last month',
    'Custom',
  ])
})
test('A10 monthly and annual ranges clamp leap days and choose useful grouping', () => {
  assert.deepEqual(presetRange('1 month', 'UTC', new Date('2026-03-31T12:00Z')), {
    from: '2026-03-01',
    to: '2026-03-31',
    grouping: 'daily',
  })
  assert.deepEqual(presetRange('1 year', 'UTC', new Date('2028-02-29T12:00Z')), {
    from: '2027-03-01',
    to: '2028-02-29',
    grouping: 'monthly',
  })
  assert.deepEqual(presetRange('Last week', 'America/New_York', new Date('2026-03-09T12:00Z')), {
    from: '2026-03-02',
    to: '2026-03-08',
    grouping: 'daily',
  })
})
test('A11 invalid and inverted date ranges fail the shared query contract', () => {
  assert.equal(
    analyticsQuerySchema.safeParse({ from: '2026-03-31', to: '2026-03-01' }).success,
    false
  )
  assert.equal(
    analyticsQuerySchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success,
    false
  )
  assert.equal(initialQuery({ timeZone: 'Mars/Olympus' }, 'UTC').timeZone, 'UTC')
})
test('A15/A20 follower growth never sums totals or bridges missing intervals', () => {
  const m = {
    ...report().metrics.followers,
    points: [
      point('2026-03-01', 100),
      point('2026-03-02', null),
      point('2026-03-03', 120),
      point('2026-03-04', 120),
    ],
  }
  assert.deepEqual(
    chartPoints(m, false).map((p) => p.value),
    [100, null, 120, 120]
  )
  assert.deepEqual(
    chartPoints(m, true).map((p) => p.value),
    [null, null, null, 0]
  )
})
test('A34 CSV uses UTF-8 BOM, CRLF, quotes, exact numbers and formula-safe text', () => {
  const file = csv([
    ['text', 'number'],
    ['=HYPERLINK("bad")', 1234567.123456789],
    ['@SUM(1)', 0],
    ['comma, quote"\nline', null],
    ['  -formula', -3],
  ])
  assert.ok(file.startsWith('\uFEFF"text","number"\r\n'))
  assert.ok(file.includes('"\'=HYPERLINK(""bad"")","1234567.123456789"'))
  assert.ok(file.includes('"\'@SUM(1)","0"'))
  assert.ok(file.includes('"comma, quote""\nline",""'))
  assert.ok(file.includes('"\'  -formula","-3"'))
})
test('A12/A34 exports include their explicit account/date/grouping snapshot', () => {
  const r = report(),
    file = chartCSV(r, 'followers', false)
  for (const value of [
    'Same name',
    'x',
    '2026-03-01',
    '2026-03-31',
    'America/New_York',
    'daily',
    r.asOf,
  ])
    assert.ok(file.includes(value))
  assert.ok(postsCSV(r).includes('"published_at_utc","observed_at_utc"'))
})
test('A35 chart export remains available with a real zero series and no post rows', () => {
  const r = report()
  assert.equal(r.posts.length, 0)
  assert.ok(chartCSV(r, 'followers', false).includes('"2026-03-01","0","1"'))
})

test('P19/P22 slots cross the date line without shifting the account schedule', () => {
  const slots = displayDaySlots(
    '2026-10-24',
    'Etc/GMT+12',
    'Pacific/Kiritimati',
    [{ weekday: 1, time: '00:30' }],
    [],
    new Date('2026-10-01')
  )
  assert.equal(slots.length, 1)
  assert.equal(slots[0].localDay, '2026-10-26')
  assert.equal(slots[0].displayTime, '22:30')
  assert.equal(slots[0].at, '2026-10-25T10:30:00.000Z')
})

test('A17 missing null and invalid series fail locally while valid zero metrics survive', () => {
  assert.deepEqual(chartPoints(undefined, false), [])
  assert.deepEqual(chartPoints(null, true), [])
  const result = readAnalyticsReport({
    ...report(),
    metrics: {
      followers: metric,
      impressions: { ...metric, points: undefined },
      profileClicks: null,
    },
  })
  assert.equal(result.metrics.followers.value, 0)
  assert.equal(result.metrics.impressions.status, 'failed')
  assert.equal(result.metrics.profileClicks.status, 'failed')
  assert.equal(result.metrics.engagements.status, 'insufficient')
})

test('a destination reads as overdue, publishing, needing a check or failed, never just scheduled', () => {
  const now = Date.parse('2026-11-02T09:00:00Z')
  const at = (offset: number) => new Date(now + offset).toISOString()
  assert.equal(postState('SCHEDULED', at(60_000), now), 'Scheduled')
  assert.equal(postState('SCHEDULED', at(-OVERDUE_AFTER_MS + 1_000), now), 'Scheduled')
  assert.equal(postState('SCHEDULED', at(-OVERDUE_AFTER_MS - 1_000), now), 'Overdue')
  assert.equal(postState('PROCESSING', at(-3_600_000), now), 'Publishing')
  assert.equal(postState('UNKNOWN_DELIVERY', at(0), now), 'Needs check')
  assert.equal(postState('FAILED', at(0), now), 'Failed')
  assert.equal(postState('PUBLISHED', at(0), now), 'Published')
  assert.equal(postState('CANCELLED', at(0), now), 'Cancelled')
})

test('every recorded failure code reads as something a person can act on', () => {
  assert.equal(postFailureReason(null), null)
  assert.match(postFailureReason('MEDIA_UNAVAILABLE') ?? '', /nothing was sent/)
  assert.match(postFailureReason('MISSED_WINDOW') ?? '', /not sent.*Publish it now or reschedule/)
  assert.match(postFailureReason('APPROVAL_REQUIRED') ?? '', /approved/)
  assert.match(postFailureReason('CHANGES_REQUESTED') ?? '', /asked for changes/)
  assert.match(postFailureReason('NOT_LIVE') ?? '', /not published\. Retry/)
  assert.match(postFailureReason('ACCOUNT_UNAVAILABLE') ?? '', /Reconnect/)
  assert.match(postFailureReason('UNKNOWN_DELIVERY') ?? '', /may already be live/)
  assert.match(postFailureReason('503') ?? '', /platform had an error/)
  assert.match(postFailureReason('400') ?? '', /rejected/)
  assert.match(postFailureReason('SOCIAL_ERROR') ?? '', /SOCIAL_ERROR/)
})

test('a status filter saved before the finer states still shows every post in its group', () => {
  const base = {
    draftId: 'd',
    version: 1,
    calendarVersion: 1,
    setId: 's',
    platform: 'x',
    at: '2026-11-02T09:00:00Z',
    zone: 'UTC',
    title: '',
    text: '',
    tagIds: [],
  }
  const items: PlanItem[] = [
    'Scheduled',
    'Overdue',
    'Publishing',
    'Published',
    'Failed',
    'Needs check',
    'Planned',
  ].map((status) => ({ ...base, id: status, status }))
  const shown = (statuses: string[]) =>
    visibleItems(items, planPreferencesSchema.parse({ statuses })).map((item) => item.id)
  assert.deepEqual(STATUS_GROUPS, ['Planned', 'Scheduled', 'Published', 'Failed'])
  assert.deepEqual(shown(['Scheduled']), ['Scheduled', 'Overdue', 'Publishing'])
  assert.deepEqual(shown(['Failed']), ['Failed', 'Needs check'])
  assert.equal(shown([]).length, items.length)
})

test('a draft reads as the state that needs attention first, never hiding a failure behind a success', () => {
  const now = Date.parse('2026-11-04T12:00:00Z')
  const later = '2026-11-05T12:00:00Z'
  assert.equal(draftPostsState([], now), null)
  assert.equal(draftPostsState([{ status: 'CANCELLED', scheduledFor: later }], now), null)
  assert.deepEqual(
    draftPostsState(
      [
        { status: 'PUBLISHED', scheduledFor: later },
        { status: 'FAILED', scheduledFor: later },
        { status: 'CANCELLED', scheduledFor: later },
      ],
      now
    ),
    { state: 'Failed', count: 1, total: 2 }
  )
  assert.deepEqual(
    draftPostsState(
      [
        { status: 'UNKNOWN_DELIVERY', scheduledFor: later },
        { status: 'FAILED', scheduledFor: later },
      ],
      now
    ),
    { state: 'Needs check', count: 1, total: 2 }
  )
  assert.deepEqual(
    draftPostsState([{ status: 'SCHEDULED', scheduledFor: '2026-11-04T11:00:00Z' }], now),
    { state: 'Overdue', count: 1, total: 1 }
  )
  // Every state has one colour wherever it is shown.
  assert.deepEqual(Object.keys(POST_STATE_TONE).sort(), [
    'Cancelled',
    'Failed',
    'Needs check',
    'Overdue',
    'Published',
    'Publishing',
    'Scheduled',
  ])
})

test('a month day caps its posts but never hides one that needs attention', () => {
  const day = (...statuses: string[]) =>
    statuses.map((status, i) => ({ ...items[0], id: `item-${i}`, status }))
  const ids = (found: PlanItem[]) => found.map((item) => item.id)

  const quiet = visibleDayItems(day('Scheduled', 'Planned'))
  assert.deepEqual([quiet.visible.length, quiet.hidden], [2, 0])

  const over = visibleDayItems(day('Scheduled', 'Published', 'Planned', 'Published'))
  assert.deepEqual(ids(over.visible), ['item-0', 'item-1'])
  assert.equal(over.hidden, 2)

  // A failure late in the day is shown in its own place, and takes a slot from a quiet post.
  const late = visibleDayItems(day('Scheduled', 'Published', 'Planned', 'Failed'))
  assert.deepEqual(ids(late.visible), ['item-0', 'item-3'])
  assert.equal(late.hidden, 2)

  // More attention than the cap still shows every one.
  const failing = visibleDayItems(day('Failed', 'Needs check', 'Scheduled', 'Overdue'))
  assert.deepEqual(ids(failing.visible), ['item-0', 'item-1', 'item-3'])
  assert.equal(failing.hidden, 1)
})

test('saved calendar preferences from before Show all still load', () => {
  assert.equal(planPreferencesSchema.parse({ view: 'month' }).showAll, false)
})
