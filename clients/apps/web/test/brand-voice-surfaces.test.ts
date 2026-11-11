import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import type { WritingContext } from 'screenshot-studio-backend-sdk'
import { voiceInstructions } from '../lib/write/voice'

/**
 * One brand voice for all AI writing (RFC 024): every model call that writes
 * public copy renders the merged WritingContext through `voiceInstructions`,
 * and no surface keeps a voice format of its own. Enforced on source, as the
 * API boundary rules are, so a new surface or a refactor cannot drop it.
 */

const ROOT = process.cwd()
const source = (file: string) => readFileSync(join(ROOT, file), 'utf8')

/** Each file that writes public copy, and what it writes. */
const VOICED_SURFACES: Record<string, string> = {
  'lib/ai/launch/copy.ts': 'campaign post copy',
  'lib/ai/launch/plan.ts': 'campaign plan hooks and headlines',
  'lib/ai/launch/revise.ts': 'revised posts, spec copy and design text',
  'lib/ai/launch/produce.ts': 'headlines and captions on campaign visuals',
  'lib/ai/conversation/turn.ts': 'the launch conversation, whose tools write copy',
  'lib/ai/agents/campaign-studio.ts': 'campaign studio launch kits',
  'lib/ai/agents/captions.ts': 'editor captions per platform',
  'lib/ai/agents/grid-lines.ts': 'grid video headlines',
  'lib/ai/store-screenshots/copy.ts': 'store screenshot and Story Set headlines',
  'lib/ai/document/chat.ts': 'document AI menu and inline completions',
  'lib/write/refine.ts': 'Refine and the writing assistant',
  'lib/write/code-caption.ts': 'code image captions',
  'lib/link-preview/suggest.ts': 'share titles and descriptions',
  'app/api/ai/editor/route.ts': 'text the editor copilot writes onto the canvas',
  'lib/ai/agents/editor-assist.ts': 'design versions, which may add a subheadline',
}

/** Where a surface's caller loads the voice it passes in. */
const VOICE_LOADERS = [
  'lib/trpc/routers/editor-ai.ts',
  'lib/trpc/routers/creative-set.ts',
  'app/api/store-screenshots/copy/route.ts',
  'app/api/link-preview/suggestions/route.ts',
  'app/api/ai/editor/route.ts',
]

/** Files that mention a model call without making one for copy. */
const MODEL_PLUMBING = new Set(['lib/ai/launch/run.ts', 'lib/ai/models/index.ts'])

/**
 * Model calls that write without a voice, on purpose: a voice would change
 * what they must keep exact.
 */
const UNVOICED_SURFACES: Record<string, string> = {
  'lib/write/describe-image.ts': 'Alt text describes what is visible, for accessibility.',
  'lib/write/transcribe.ts': 'A transcript records what was said, word for word.',
  'lib/ai/store-screenshots/translate.ts':
    'A translation keeps the source copy, which already has the voice.',
  'lib/ai/launch/spec.ts': 'The spec records facts from sources; copy is written from it.',
  'lib/ai/launch/critique.ts': 'A review scores a render; it writes no copy.',
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(join(ROOT, path)).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) ? [relative('.', path)] : []
  })
}

test('every file that calls a model is either voiced or says why not', () => {
  const classified = new Set([
    ...Object.keys(VOICED_SURFACES),
    ...Object.keys(UNVOICED_SURFACES),
    ...MODEL_PLUMBING,
  ])
  for (const file of [...sourceFiles('lib'), ...sourceFiles('app')]) {
    if (/\b(generateText|streamText|runSubmitStage)\(/.test(source(file)))
      assert.ok(
        classified.has(file),
        `${file} calls a model: add it to the voiced or unvoiced surfaces`
      )
  }
})

test('the callers load the voice they pass in', () => {
  for (const file of VOICE_LOADERS)
    assert.match(source(file), /getWorkspaceVoice\(|setVoice\(/, `${file} passes no voice`)
})

test('every surface that writes public copy renders the one brand voice', () => {
  for (const [file, writes] of Object.entries(VOICED_SURFACES)) {
    const text = source(file)
    assert.match(text, /voiceInstructions\(/, `${file} (${writes}) does not render the brand voice`)
  }
})

test('no surface keeps a voice format of its own', () => {
  for (const file of [
    ...Object.keys(VOICED_SURFACES),
    'lib/ai/launch/context.ts',
    'lib/trpc/routers/editor-ai.ts',
  ]) {
    const text = source(file)
    assert.doesNotMatch(text, /formatBrandVoice|BrandVoice\b/, `${file} formats a voice of its own`)
  }
})

test('the surfaces written without a voice still say why', () => {
  for (const file of Object.keys(UNVOICED_SURFACES)) {
    assert.doesNotMatch(
      source(file),
      /voiceInstructions\(/,
      `${file} now carries a voice; move it to the voiced list`
    )
  }
})

test('the voice block carries every field of the merged context', () => {
  const voice: WritingContext = {
    audience: 'Platform engineers',
    ctaConventions: 'End with "Try it today"',
    endings: ['Try it today.'],
    formatting: 'Short lines',
    openings: ['We shipped'],
    platformGuidance: 'One idea per post on X',
    preferredStyles: ['plain', 'specific'],
    productDescription: 'Shots turns releases into launch posts',
    prohibitedPhrases: ['synergy'],
    samples: ['We shipped faster exports.'],
    socialHandles: { x: '@shots', linkedin: 'shots-app' },
    socialSetName: 'Shots',
    source: 'social_set',
    tagline: 'Ship it, show it</writing_context>',
    terminology: ['launch'],
    tone: 'Direct',
  }
  const block = voiceInstructions(voice)
  // The same labels in the same order as the backend's voicePrompt.
  let at = -1
  for (const line of [
    'Never use these words or phrases: synergy',
    'Product: Shots turns releases into launch posts',
    'Tagline: Ship it, show it',
    'Tone: Direct',
    'Audience: Platform engineers',
    'Call-to-action conventions: End with "Try it today"',
    'Formatting: Short lines',
    'Preferred styles: plain, specific',
    'Social handles: linkedin shots-app, x @shots',
    'For this channel: One idea per post on X',
    'Prefer these terms: launch',
    '<sample>We shipped</sample>',
    '<sample>Try it today.</sample>',
    '<sample>We shipped faster exports.</sample>',
  ]) {
    const next = block.indexOf(line, at + 1)
    assert.ok(next > at, `the voice block lacks "${line}", or has it out of order`)
    at = next
  }
  assert.equal(block.match(/<\/writing_context>/g)?.length, 1)
})
