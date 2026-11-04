import assert from 'node:assert/strict'
import test from 'node:test'
import { diffStats, lineDiff, splitRows } from '@/lib/code-studio/diff'
import { newCodeDocument, newCodeFile, newCodeSlide } from '@/lib/code-studio/document'
import {
  duplicateSlide,
  moveSlide,
  normalizeRanges,
  removeSlide,
  setLayout,
  toggleMark,
  updateFile,
} from '@/lib/code-studio/edit'
import { HUNK_GAP, importedSlides, patchSides, withImport } from '@/lib/code-studio/import'
import { documentSize, fitAspect, slideSize } from '@/lib/code-studio/layout'
import {
  compileTape,
  parseDuration,
  screenAt,
  screenLines,
  TAPE_PROMPT,
} from '@/lib/code-studio/tape'
import {
  ease,
  frameAt,
  morphTokens,
  placeTokens,
  slideHold,
  typedLengths,
  videoDuration,
} from '@/lib/code-studio/timeline'

test('a line diff marks removals before additions and keeps unchanged lines', () => {
  const rows = lineDiff('a\nb\nc', 'a\nB\nc\nd')
  assert.deepEqual(rows, [
    { kind: 'same', before: 1, after: 1 },
    { kind: 'del', before: 2 },
    { kind: 'add', after: 2 },
    { kind: 'same', before: 3, after: 3 },
    { kind: 'add', after: 4 },
  ])
  assert.deepEqual(diffStats(rows), { added: 2, removed: 1 })
  assert.deepEqual(splitRows(rows), [
    { before: 1, after: 1, kind: 'same' },
    { before: 2, after: 2, kind: 'change' },
    { before: 3, after: 3, kind: 'same' },
    { before: undefined, after: 4, kind: 'change' },
  ])
  assert.deepEqual(lineDiff('same', 'same'), [{ kind: 'same', before: 1, after: 1 }])
})

test('a unified patch gives the before and after of each hunk', () => {
  const sides = patchSides(
    '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n@@ -9 +9 @@\n-x\n+y\n\\ No newline at end of file'
  )
  assert.equal(sides.before, `keep\nold\n${HUNK_GAP}\nx`)
  assert.equal(sides.after, `keep\nnew\n${HUNK_GAP}\ny`)
})

test('a change imports as diffs, or as before and after slides to animate', () => {
  const result = {
    kind: 'github-pull' as const,
    url: 'https://github.com/acme/api/pull/7',
    repo: 'acme/api',
    files: [{ name: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }, { name: 'logo.png' }],
  }
  const diffs = importedSlides(result, 'diff')
  assert.equal(diffs.length, 1)
  const file = diffs[0]!.panes[0]!.files[0]!
  assert.equal(file.name, 'a.ts')
  assert.equal(file.lang, 'typescript')
  assert.equal(file.base, 'old')
  assert.equal(file.code, 'new')
  const steps = importedSlides(result, 'animate')
  assert.deepEqual(
    steps.map((slide) => [slide.panes[0]!.files[0]!.code, slide.transition]),
    [
      ['old', 'cut'],
      ['new', 'morph'],
    ]
  )
  // The starter snippet is replaced; real work is kept and the import follows it.
  const starter = withImport(newCodeDocument(), diffs, 0, result)
  assert.equal(starter.document.slides.length, 1)
  assert.equal(starter.document.source?.repo, 'acme/api')
  const kept = withImport(newCodeDocument({ code: 'mine' }), diffs, 0)
  assert.equal(kept.document.slides.length, 2)
  assert.equal(kept.slide, 1)
})

test('emphasis toggles merge and split ranges', () => {
  assert.deepEqual(
    normalizeRanges([
      [5, 6],
      [1, 2],
      [3, 3],
    ]),
    [
      [1, 3],
      [5, 6],
    ]
  )
  const on = toggleMark(undefined, 'highlight', [2, 4])
  assert.deepEqual(on.highlight, [[2, 4]])
  const off = toggleMark(on, 'highlight', [3, 3])
  assert.deepEqual(off.highlight, [
    [2, 2],
    [4, 4],
  ])
  assert.deepEqual(toggleMark(off, 'highlight', [2, 4]).highlight, [[2, 4]])
})

test('slide edits keep ids unique and a project never empty', () => {
  const document = newCodeDocument({ code: 'a' })
  const two = duplicateSlide(document, 0)
  assert.equal(two.slides.length, 2)
  assert.notEqual(two.slides[0]!.id, two.slides[1]!.id)
  assert.notEqual(two.slides[0]!.panes[0]!.files[0]!.id, two.slides[1]!.panes[0]!.files[0]!.id)
  assert.equal(removeSlide(document, 0), document)
  const moved = moveSlide(two, 1, -1)
  assert.equal(moved.slides[0]!.id, two.slides[1]!.id)
  const split = setLayout(document, 0, 'split')
  assert.equal(split.slides[0]!.panes.length, 2)
  assert.equal(setLayout(split, 0, 'single').slides[0]!.panes.length, 1)
  const slide = document.slides[0]!
  const edited = updateFile(
    document,
    { slide: 0, pane: slide.panes[0]!.id, file: slide.panes[0]!.files[0]!.id },
    { code: 'b', base: undefined }
  )
  assert.equal(edited.slides[0]!.panes[0]!.files[0]!.code, 'b')
  assert.equal(document.slides[0]!.panes[0]!.files[0]!.code, 'a', 'the input was changed')
})

test('scene sizes grow to the aspect without cropping, and slides share one size', () => {
  assert.deepEqual(fitAspect({ width: 800, height: 300 }, '1:1'), { width: 800, height: 800 })
  assert.deepEqual(fitAspect({ width: 800, height: 900 }, '16:9'), { width: 1600, height: 900 })
  const short = newCodeDocument({ code: 'a' })
  const long = {
    ...short,
    slides: [...short.slides, newCodeSlide([newCodeFile({ code: 'a\n'.repeat(30) })])],
  }
  assert.ok(slideSize(long, 1).height > slideSize(long, 0).height)
  assert.deepEqual(documentSize(long), slideSize(long, 1))
})

test('a tape script types, prints and clears without running anything', () => {
  assert.equal(parseDuration('500ms'), 500)
  assert.equal(parseDuration('2'), 2_000)
  assert.equal(parseDuration('1.5s'), 1_500)
  assert.equal(parseDuration('soon'), null)
  const script =
    'Set TypingSpeed 10ms\nType "ls"\nEnter\nPrint "a.txt\\nb.txt"\nSleep 1s\nType "rm -rf /"\nSource evil.tape'
  const compiled = compileTape(script)
  assert.equal(compiled.warnings.length, 1)
  assert.match(compiled.warnings[0]!, /Source is not supported/)
  assert.deepEqual(screenLines(script), [
    `${TAPE_PROMPT}ls`,
    'a.txt',
    'b.txt',
    `${TAPE_PROMPT}rm -rf /`,
  ])
  assert.deepEqual(screenAt(script, 10), [`${TAPE_PROMPT}l`])
  assert.deepEqual(screenLines('Type "x"\nCtrl+L\nType "y"'), [`${TAPE_PROMPT}y`])
  assert.deepEqual(screenLines('Type "ab"\nBackspace 5'), [TAPE_PROMPT])
})

test('the timeline holds, transitions and covers terminal scripts', () => {
  const document = newCodeDocument({ code: 'a' })
  const second = newCodeSlide([newCodeFile({ code: 'a\nb' })], {
    transition: 'morph',
    transitionDuration: 1_000,
    duration: 2_000,
  })
  const video = {
    ...document,
    slides: [{ ...document.slides[0]!, duration: 1_000, transition: 'cut' as const }, second],
  }
  assert.equal(videoDuration(video), 1_000 + 1_000 + 2_000)
  assert.deepEqual(frameAt(video, 500), {
    slide: 0,
    from: null,
    transition: null,
    progress: 1,
    local: 500,
  })
  const mid = frameAt(video, 1_500)
  assert.equal(mid.slide, 1)
  assert.equal(mid.from, 0)
  assert.equal(mid.transition, 'morph')
  assert.equal(mid.progress, ease(0.5))
  assert.equal(frameAt(video, 99_999).slide, 1)
  const tape = newCodeSlide([newCodeFile({ code: '', tape: 'Type "abcdefghij"\nSleep 5s' })], {
    duration: 500,
  })
  assert.ok(slideHold(tape) > 5_000)
})

test('morphs move matched tokens and fade the rest; typing fills added lines in order', () => {
  const from = placeTokens([
    { key: 'k1', content: 'let' },
    { key: 'x', content: '\n' },
    { key: 'k2', content: 'a' },
  ])
  const to = placeTokens([
    { key: 'k2', content: 'a' },
    { key: 'y', content: '\n' },
    { key: 'k3', content: 'b' },
  ])
  const half = morphTokens(from, to, 0.5)
  const moved = half.find((token) => token.key === 'k2')!
  assert.equal(moved.line, 0.5)
  assert.equal(half.find((token) => token.key === 'k1')!.opacity, 0)
  assert.equal(half.find((token) => token.key === 'k3')!.opacity, 0)
  assert.equal(morphTokens(from, to, 1).find((token) => token.key === 'k3')!.opacity, 1)
  assert.deepEqual(typedLengths('a', 'a\nbc\nd', 0), [1, 0, 0])
  assert.deepEqual(typedLengths('a', 'a\nbc\nd', 0.5), [1, 2, 0])
  assert.deepEqual(typedLengths('a', 'a\nbc\nd', 1), [1, 2, 1])
})
