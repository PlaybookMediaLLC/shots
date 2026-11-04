import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  channelProblem,
  matchCaptions,
  matchRowMedia,
  parseBatchCSV,
  parseCaptionCSV,
  unusedFiles,
} from '@/lib/write/bulk-import'

const asset = '0f8b5c1e-3d2a-4b7c-9e1f-2a3b4c5d6e7f'

test('CSV preserves quoted commas, line breaks, Unicode, literal formulas, and escaped quotes', () => {
  const { rows } = parseBatchCSV(
    '﻿caption,asset,channels\r\n"Hello, ""team""\n🚀",design.png;b.png,x;LinkedIn\r\n=SUM(1),,x'
  )
  assert.deepEqual(rows, [
    {
      line: 2,
      caption: 'Hello, "team"\n🚀',
      assets: ['design.png', 'b.png'],
      channels: ['x', 'linkedin'],
      problems: [],
    },
    // The caption above spans two lines, so this row starts on line 4.
    { line: 4, caption: '=SUM(1)', assets: [], channels: ['x'], problems: [] },
  ])
})

test('rows are named by the file line they start on, past captions with line breaks', () => {
  const { rows } = parseBatchCSV('caption,asset\n"First\nsecond line",a.png\n\nNext,b.png\nLast,')
  assert.deepEqual(
    rows.map((row) => [row.line, row.caption]),
    [
      [2, 'First\nsecond line'],
      [5, 'Next'],
      [6, 'Last'],
    ]
  )
  assert.match(matchRowMedia(rows[1], [], new Set()).problems[0], /^Line 5:/)
})

test('the mapping is shown: unknown columns are listed as ignored, times and zones are read', () => {
  const { mapping, rows } = parseBatchCSV(
    'Caption,Time,Time Zone,Notes\nLaunch,2026-11-03 09:30,Europe/Paris,internal\nLater,2026-11-03 9:30,Mars/Base,\n'
  )
  assert.deepEqual(mapping, [
    { header: 'Caption', field: 'caption' },
    { header: 'Time', field: 'time' },
    { header: 'Time Zone', field: 'timezone' },
    { header: 'Notes', field: null },
  ])
  assert.equal(rows[0].time, '2026-11-03T09:30')
  assert.equal(rows[0].timeZone, 'Europe/Paris')
  assert.match(rows[1].problems.join(' '), /time must look like/)
  assert.match(rows[1].problems.join(' '), /IANA zone/)
  // A day or hour that does not exist is the row's problem, not the whole import's.
  const impossible = parseBatchCSV(
    'caption,time\nA,2027-02-30 09:30\nB,2026-11-03 24:00\nC,2028-02-29 23:59\n'
  ).rows
  assert.deepEqual(
    impossible.map((row) => row.problems.length),
    [1, 1, 0]
  )
})

test('CSV refuses malformed input and takes exactly fifty rows', () => {
  for (const text of [
    'caption\n"unfinished',
    'caption,caption\na,b',
    'asset\nx',
    'caption\n"a"b',
    'caption',
  ])
    assert.throws(() => parseBatchCSV(text))
  assert.match(parseBatchCSV('caption,asset\none').rows[0].problems[0], /wrong number of fields/)
  assert.equal(parseBatchCSV('caption\n' + Array(100).fill('item').join('\n')).rows.length, 100)
  assert.throws(() => parseBatchCSV('caption\n' + Array(101).fill('item').join('\n')), /100/)
})

test('media matches an exact selected name or a confirmed asset, and flags everything else', () => {
  const files = [
    { name: 'hero.png', size: 10 },
    { name: 'clip.mov', size: 20 },
    { name: 'twice.png', size: 1 },
    { name: 'twice.png', size: 2 },
    { name: 'spare.jpg', size: 3 },
  ]
  const { rows } = parseBatchCSV(
    `caption,asset\nA,hero.png;${asset};clip.mov\nB,twice.png\nC,0f8b5c1e-0000-4b7c-9e1f-2a3b4c5d6e7f\nD,Hero.PNG\n`
  )
  const known = new Set([asset])
  assert.deepEqual(matchRowMedia(rows[0], files, known), {
    media: [
      { fileName: 'hero.png', bytes: 10 },
      { assetId: asset },
      { fileName: 'clip.mov', bytes: 20 },
    ],
    problems: [],
  })
  assert.match(
    matchRowMedia(rows[1], files, known).problems[0],
    /Two selected files are named twice.png/
  )
  assert.match(matchRowMedia(rows[2], files, known).problems[0], /not in this workspace/)
  // Names match exactly; a different case is not guessed.
  assert.match(
    matchRowMedia(rows[3], files, known).problems[0],
    /no selected file is named Hero.PNG/
  )
  assert.deepEqual(unusedFiles(rows, files), ['spare.jpg'])
  // A corrected row matches.
  const fixed = parseBatchCSV('caption,asset\nD,hero.png').rows[0]
  assert.deepEqual(matchRowMedia(fixed, files, known).problems, [])
})

test('a file name storage cannot key is stored under a safe name, and a clash is flagged', () => {
  const { rows } = parseBatchCSV('caption,asset\nA,Product launch.png\nB,a b.png\nC,日本\n')
  const files = [
    { name: 'Product launch.png', size: 5 },
    { name: 'a b.png', size: 1 },
    { name: 'a-b.png', size: 2 },
    { name: '日本', size: 3 },
  ]
  assert.deepEqual(matchRowMedia(rows[0], files, new Set()), {
    media: [{ fileName: 'Product-launch.png', bytes: 5 }],
    problems: [],
  })
  assert.match(
    matchRowMedia(rows[1], files, new Set()).problems[0],
    /would both be saved as a-b.png/
  )
  assert.match(matchRowMedia(rows[2], files, new Set()).problems[0], /no letters or digits/)
})

test('IMPORT-01: review flags unknown and unconnected channels, never unassigned rows', () => {
  const [unknown, unconnected, unassigned, connected] = parseBatchCSV(
    'caption,asset,channels\nA,,not-a-channel\nB,,x\nC,,\nD,,LinkedIn'
  ).rows
  assert.match(
    channelProblem(unknown.channels, ['linkedin']) ?? '',
    /Unknown channel not-a-channel/
  )
  assert.match(channelProblem(unconnected.channels, ['linkedin']) ?? '', /No connected x account/)
  assert.equal(channelProblem(unassigned.channels, []), undefined)
  assert.equal(channelProblem(connected.channels, ['linkedin']), undefined)
})

const targets = [
  { id: 'first', names: ['my-first-video.mp4', 'My First Video.mp4'] },
  { id: 'second', names: ['my-second-video.mp4'] },
  { id: 'trip', names: ['Trip', 'beach.png', 'cover.png'] },
]

test('the supplied two-column sample parses with its header, quotes and commas', () => {
  const rows = parseCaptionCSV(
    readFileSync(
      new URL(
        '../../../../docs/scheduling/post-bridge/bulk-tools/bulk-video-caption-sample.csv',
        import.meta.url
      ),
      'utf8'
    )
  )
  assert.equal(rows.length, 3)
  assert.equal(rows[0]?.key, 'my-first-video.mp4')
  assert.equal(rows[2]?.caption, 'Captions with commas, need quotes #hashtags')
})

test('caption CSVs take a BOM, quoted newlines, an optional header and one column', () => {
  assert.deepEqual(
    parseCaptionCSV('\uFEFFa.mp4,"one\ntwo"\nb.mp4,three').map((row) => [row.key, row.caption]),
    [
      ['a.mp4', 'one\ntwo'],
      ['b.mp4', 'three'],
    ]
  )
  assert.deepEqual(
    parseCaptionCSV('Caption\nFirst\n"Second, with comma"').map((row) => [row.key, row.caption]),
    [
      [undefined, 'First'],
      [undefined, 'Second, with comma'],
    ]
  )
  assert.equal(parseCaptionCSV('First\nSecond').length, 2)
  assert.throws(() => parseCaptionCSV('a,b,c\n'), /two columns/)
  assert.throws(() => parseCaptionCSV('\n'), /no captions/)
  assert.deepEqual(parseCaptionCSV('a.mp4,one\nb.mp4')[1]?.problems, [
    'Line 2 has the wrong number of fields.',
  ])
})

test('captions match by name, without case, with the extension optional', () => {
  const { matches, unchanged } = matchCaptions(
    parseCaptionCSV('MY-FIRST-VIDEO.MP4,one\nMy Second Video.mp4,two\ntrip,three'),
    targets
  )
  assert.deepEqual(
    matches.map((match) => match.itemId),
    ['first', 'second', 'trip']
  )
  assert.deepEqual(unchanged, [])
  assert.equal(
    matchCaptions(parseCaptionCSV('my-first-video,one'), targets).matches[0]?.itemId,
    'first'
  )
  assert.equal(matchCaptions(parseCaptionCSV('beach.png,one'), targets).matches[0]?.itemId, 'trip')
})

test('one-column captions follow the posts in order, and what is left is named', () => {
  const few = matchCaptions(parseCaptionCSV('One\nTwo'), targets)
  assert.deepEqual(
    few.matches.map((match) => match.itemId),
    ['first', 'second']
  )
  assert.deepEqual(
    few.unchanged.map((target) => target.id),
    ['trip']
  )
  const many = matchCaptions(parseCaptionCSV('One\nTwo\nThree\nFour'), targets)
  assert.deepEqual(many.matches[3]?.problems, ['Line 4 has no post left to go to.'])
})

test('unmatched, ambiguous and repeated names are problems, never guesses', () => {
  const { matches, unchanged } = matchCaptions(
    parseCaptionCSV('missing.mp4,a\nsame,b\nbeach.png,c\ncover.png,d'),
    [...targets, { id: 'x', names: ['same.mp4'] }, { id: 'y', names: ['same.mov'] }]
  )
  assert.deepEqual(matches[0]?.problems, ['Line 1: no post is named missing.mp4.'])
  assert.deepEqual(matches[1]?.problems, ['Line 2: same matches 2 posts.'])
  assert.deepEqual(matches[2]?.problems, ['Lines 3 and 4 name the same post. Keep one.'])
  assert.deepEqual(matches[3]?.problems, ['Lines 3 and 4 name the same post. Keep one.'])
  assert.equal(
    matches.some((match) => match.itemId),
    false
  )
  assert.equal(unchanged.length, 5)
})
