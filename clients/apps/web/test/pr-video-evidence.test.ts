import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const CLI_PATH = join(REPO_ROOT, 'dev/pr-video-evidence/cli.mjs')
import {
  buildCaptionsAndTranscript,
  formatSrtTime,
  formatVttTime,
  measureAudioVolume,
  parseProbeDuration,
  sanitizeFileStem,
  wrapCaptionText,
} from '../../../../dev/pr-video-evidence/compose.mjs'
import {
  formatTimestamp,
  renderPrEvidenceMarkdown,
  upsertPrEvidenceBlock,
} from '../../../../dev/pr-video-evidence/markdown.mjs'
import {
  assertValidCues,
  EvidenceRecorder,
} from '../../../../dev/pr-video-evidence/playwright-helpers.mjs'
import {
  checkAutomatedPrExemption,
  detectSensitiveData,
  EVIDENCE_BLOCK_END,
  EVIDENCE_BLOCK_START,
  EVIDENCE_SCHEMA_VERSION,
  extractManifestFromPrBody,
  isAccessibleVideoUrl,
  validateManifest,
  validatePrEvidence,
} from '../../../../dev/pr-video-evidence/schema.mjs'

const VALID_SHA = 'a'.repeat(40)
const STALE_SHA = 'b'.repeat(40)

function makeValidRecordedManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    status: 'recorded',
    repository: 'PlaybookMediaLLC/shots',
    branch: 'feat/demo',
    commitSha: VALID_SHA,
    pullRequestNumber: 677,
    capturedAt: '2026-11-28T09:00:00.000Z',
    testEnvironment: 'native-stack',
    applicationRoutes: ['/home', '/editor'],
    redactionConfirmed: true,
    acceptanceCriteria: [
      {
        id: 'AC-1',
        description: 'Workspace overview loads for authenticated Pro workspace',
        verified: true,
        timestampRange: '00:00–00:14',
      },
    ],
    assertionResults: [
      {
        suite: 'clients',
        command: 'npm run quality:check',
        status: 'passed',
        summary: 'Format, lint, typecheck, unit, and server tests passed.',
      },
    ],
    knownLimitations: ['RustFS not running under native-stack; upload flows tested in Compose.'],
    recordings: [
      {
        title: 'Shots workspace and editor verification',
        videoUrl: 'https://github.com/user-attachments/assets/00000000-0000-4000-8000-000000000001',
        durationSeconds: 42.5,
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: 'h264',
        audioCodec: 'aac',
        ttsProvider: 'kokoro-onnx',
        narrated: true,
        captioned: true,
        artifacts: {
          rawFootage: '.local/pr-evidence/demo/raw/video.webm',
          transcript: '.local/pr-evidence/demo/transcript.txt',
          captionsSrt: '.local/pr-evidence/demo/captions.srt',
          playwrightTrace: '.local/pr-evidence/demo/raw/trace.zip',
        },
      },
    ],
    review: {
      reviewedCommitSha: VALID_SHA,
      reviewers: [
        { id: 'reviewer-structure', perspective: 'structure' },
        { id: 'reviewer-qa', perspective: 'qa' },
      ],
      findingsBySeverity: { P0: 0, P1: 0, P2: 0, P3: 0 },
      recommendation: 'ship',
    },
    ...overrides,
  }
}

test('valid recorded manifest renders to markdown and round-trips cleanly', () => {
  const manifest = makeValidRecordedManifest()
  const markdown = renderPrEvidenceMarkdown(manifest)
  assert.match(markdown, /### Narrated verification/)
  assert.match(markdown, /### Demonstrated behavior/)
  assert.match(markdown, /### Automated checks/)
  assert.match(markdown, /### Independent engineering review/)
  assert.match(markdown, /### Known limitations/)

  const extracted = extractManifestFromPrBody(`PR intro paragraph.\n\n${markdown}`)
  assert.equal(extracted.found, true)
  assert.deepEqual(extracted.manifest, manifest)

  const check = validatePrEvidence({
    prBody: `PR intro paragraph.\n\n${markdown}`,
    headSha: VALID_SHA,
    prNumber: 677,
    baseRef: 'develop',
    headRef: 'feat/demo',
    headRepo: 'PlaybookMediaLLC/shots',
    repository: 'PlaybookMediaLLC/shots',
    isDraft: false,
    changedFiles: ['clients/apps/web/components/platform-ui/card.tsx'],
  })
  assert.equal(check.ok, true, check.errors.join('; '))
  assert.deepEqual(check.errors, [])
})

test('stale or missing headSha fails closed in PR evidence validation', () => {
  const manifest = makeValidRecordedManifest({ commitSha: STALE_SHA })
  const markdown = renderPrEvidenceMarkdown(manifest)

  const stale = validatePrEvidence({
    prBody: markdown,
    headSha: VALID_SHA,
    prNumber: 677,
    baseRef: 'develop',
    headRef: 'feat/demo',
    headRepo: 'PlaybookMediaLLC/shots',
    repository: 'PlaybookMediaLLC/shots',
  })
  assert.equal(stale.ok, false)
  assert.ok(stale.errors.some((e) => /Stale evidence/.test(e)))

  const missingSha = validatePrEvidence({
    prBody: markdown,
    headSha: '',
    baseRef: 'develop',
    headRef: 'feat/demo',
    headRepo: 'PlaybookMediaLLC/shots',
    repository: 'PlaybookMediaLLC/shots',
  })
  assert.equal(missingSha.ok, false)
  assert.ok(missingSha.errors.some((e) => /headSha must be a 40-character/.test(e)))
})

test('invalid codecs, resolution, fps/NaN, silent/uncaptioned video, placeholder URLs, and failed tests are rejected', () => {
  const bad = makeValidRecordedManifest({
    redactionConfirmed: false,
    acceptanceCriteria: [{ id: 'AC-1', description: 'Check', verified: false }],
    assertionResults: [{ suite: 'unit', command: 'npm test', status: 'failed', summary: '1 fail' }],
    recordings: [
      {
        title: 'Bad clip',
        videoUrl: 'http://localhost:3000/video.mp4',
        durationSeconds: 10,
        width: 640,
        height: 480,
        fps: 15,
        videoCodec: 'vp9',
        audioCodec: 'opus',
        ttsProvider: '',
        narrated: false,
        captioned: false,
      },
    ],
  })
  const res = validateManifest(bad, { headSha: VALID_SHA })
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => /redactionConfirmed/.test(e)))
  assert.ok(res.errors.some((e) => /not verified/.test(e)))
  assert.ok(res.errors.some((e) => /failed/.test(e)))
  assert.ok(res.errors.some((e) => /https:\/\//.test(e)))
  assert.ok(res.errors.some((e) => /resolution/.test(e)))
  assert.ok(res.errors.some((e) => /fps/.test(e)))
  assert.ok(res.errors.some((e) => /videoCodec/.test(e)))
  assert.ok(res.errors.some((e) => /audioCodec/.test(e)))
  assert.ok(res.errors.some((e) => /ttsProvider/.test(e)))
  assert.ok(res.errors.some((e) => /narrated/.test(e)))
  assert.ok(res.errors.some((e) => /captioned/.test(e)))

  const nanFps = makeValidRecordedManifest({
    recordings: [{ ...makeValidRecordedManifest().recordings[0], fps: Number.NaN }],
  })
  assert.equal(validateManifest(nanFps, { headSha: VALID_SHA }).valid, false)

  const longClip = makeValidRecordedManifest({
    recordings: [{ ...makeValidRecordedManifest().recordings[0], durationSeconds: 210 }],
  })
  const longRes = validateManifest(longClip, { headSha: VALID_SHA })
  assert.equal(longRes.valid, true)
  assert.ok(longRes.warnings.some((w) => /prefer concise 30–120s/.test(w)))

  const onlySkipped = makeValidRecordedManifest({
    assertionResults: [{ suite: 'e2e', command: 'make e2e', status: 'skipped', summary: 'none' }],
  })
  assert.ok(
    validateManifest(onlySkipped, { headSha: VALID_SHA }).errors.some((e) =>
      /at least one passed/.test(e)
    )
  )

  // Robotic formant synthesizers (including qualified/cased variants) are rejected.
  for (const robotic of [
    'espeak-ng',
    'espeak-ng:en-us',
    'ESPEAK_NG',
    'espeak',
    'festival/2.5',
    'flite',
    'pico2wave',
  ]) {
    const roboticManifest = makeValidRecordedManifest({
      recordings: [{ ...makeValidRecordedManifest().recordings[0], ttsProvider: robotic }],
    })
    const roboticRes = validateManifest(roboticManifest, { headSha: VALID_SHA })
    assert.equal(roboticRes.valid, false, `${robotic} must be rejected`)
    assert.ok(roboticRes.errors.some((e) => /robotic formant synthesizer/.test(e)))
  }

  // Approved neural cloud TTS providers remain accepted.
  const openaiManifest = makeValidRecordedManifest({
    recordings: [
      { ...makeValidRecordedManifest().recordings[0], ttsProvider: 'openai-tts:gpt-4o-mini-tts' },
    ],
  })
  assert.equal(validateManifest(openaiManifest, { headSha: VALID_SHA }).valid, true)
})

test('tts.py speech normalization, sentence splitting, loudnorm parser, stem collision, and voice helpers handle edge cases safely', () => {
  const pythonScript = `
import json, math, os, sys, tempfile, wave
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(join(REPO_ROOT, 'dev/pr-video-evidence'))})
import tts

spoken = {
  "basic": tts.normalize_for_speech("Check PR commit SHA with HTTP 401 on 1920x1080."),
  "sha256": tts.normalize_for_speech("Verify SHA-256 and SHA-1 digests without corrupting commit SHA hash."),
  "cli": tts.normalize_for_speech("Run CLI command for tRPC OAuth JSON SQL API URL."),
}

sentences = {
  "basic": tts.split_sentences("First sentence. Second sentence! Third one?"),
  "abbrevs": tts.split_sentences("Use e.g. Kokoro or No. 677 vs. robotic speech. Next beat."),
  "ordinal": tts.split_sentences("1. Open home. 2. Click editor."),
  "punct": tts.split_sentences("Done. ... Next step."),
}

loudnorm = {
  "valid": tts.parse_loudnorm_stats(
    'noise\\n{"input_i":"-18.5","input_tp":"-2.1","input_lra":"5.4","input_thresh":"-29.0","target_offset":"0.4"}\\n'
  ),
  "lastBlock": tts.parse_loudnorm_stats(
    '{"input_i":"-30.0","input_tp":"-5.0","input_lra":"4.0","input_thresh":"-40.0","target_offset":"0.1"}\\n'
    '{"input_i":"-16.2","input_tp":"-1.8","input_lra":"6.1","input_thresh":"-26.5","target_offset":"0.2"}'
  ),
  "negInf": tts.parse_loudnorm_stats(
    '{"input_i":"-inf","input_tp":"-inf","input_lra":"0.0","input_thresh":"-inf","target_offset":"inf"}'
  ),
  "nan": tts.parse_loudnorm_stats(
    '{"input_i":"nan","input_tp":"-1.0","input_lra":"1.0","input_thresh":"-20.0","target_offset":"0.0"}'
  ),
  "outOfRange": tts.parse_loudnorm_stats(
    '{"input_i":"12.0","input_tp":"-1.0","input_lra":"1.0","input_thresh":"-20.0","target_offset":"0.0"}'
  ),
}

cues = tts.validate_cues([
  {"id": "beat/1", "text": "First beat."},
  {"id": "beat:1", "text": "Second beat."},
  {"id": "beat_1-02", "text": "Third beat."},
])
stems = [stem for _, stem, _ in cues]

langs = {
  "us": tts.infer_kokoro_lang("af_heart"),
  "gbSingle": tts.infer_kokoro_lang("bf_emma"),
  "gbBlend": tts.infer_kokoro_lang("bf_emma:0.6+bm_george:0.4"),
  "mixed": tts.infer_kokoro_lang("af_heart:0.5+bf_emma:0.5"),
}

blend_errors = []
for bad_spec in ["", "af_heart:0+af_bella:1", "af_heart:-0.5+af_bella:1", "af_heart:nan+af_bella:1", ":0.5+af_bella:0.5"]:
  try:
    tts.resolve_kokoro_voice(object(), bad_spec)
  except RuntimeError as err:
    blend_errors.append(str(err))

openai_err = ""
saved_key = os.environ.pop("OPENAI_API_KEY", None)
try:
  tts.synthesize_openai([("b1", "b1", "Hello world.")], Path(tempfile.gettempdir()), "alloy", 0.98)
except RuntimeError as err:
  openai_err = str(err)
finally:
  if saved_key is not None:
    os.environ["OPENAI_API_KEY"] = saved_key

kokoro_err = ""
orig_ensure = tts.ensure_kokoro_models
def fail_models():
  raise RuntimeError("offline")
tts.ensure_kokoro_models = fail_models
try:
  tts.synthesize_kokoro([("b1", "b1", "Hello world.")], Path(tempfile.gettempdir()), "af_heart", 0.98)
except RuntimeError as err:
  kokoro_err = str(err)
finally:
  tts.ensure_kokoro_models = orig_ensure

# Verify run_parallel_cues passes normalized speech to render_raw while preserving verbatim caption text.
caption_text = "Inspect PR commit SHA on 1920x1080."
captured_spoken = []
short_duration = None
ffmpeg_checked = False
with tempfile.TemporaryDirectory() as td:
  td_path = Path(td)
  def write_short_wav(spoken_text, raw_path):
    captured_spoken.append(spoken_text)
    sr = 24000
    n = int(sr * 0.25)
    with wave.open(str(raw_path), "wb") as wf:
      wf.setnchannels(1)
      wf.setsampwidth(2)
      wf.setframerate(sr)
      frames = bytearray()
      for i in range(n):
        sample = int(12000 * math.sin(2.0 * math.pi * 440.0 * i / sr))
        frames.extend(sample.to_bytes(2, "little", signed=True))
      wf.writeframes(bytes(frames))

  orig_norm = tts.normalize_to_wav
  def fake_norm(src, dest):
    dest.write_bytes(src.read_bytes())
    return tts.measure_wav_duration(dest)
  tts.normalize_to_wav = fake_norm
  try:
    segs = tts.run_parallel_cues([("b1", "b1", caption_text)], td_path, write_short_wav, max_workers=1)
    returned_caption = segs[0]["text"]
  finally:
    tts.normalize_to_wav = orig_norm

  import shutil
  if shutil.which("ffmpeg") is not None:
    raw_short = td_path / "short.raw.wav"
    final_short = td_path / "short.wav"
    write_short_wav("short", raw_short)
    short_duration = tts.normalize_to_wav(raw_short, final_short)
    ffmpeg_checked = True

numpy_checked = False
try:
  import numpy as np
  faded = tts.apply_edge_fade(np.ones(2400, dtype=np.float32), 24000, fade_ms=12)
  assert float(faded[0]) == 0.0 and float(faded[-1]) == 0.0
  assert float(faded[1200]) == 1.0
  class FakeKokoro:
    def get_voice_style(self, name):
      return np.array([1.0, 0.0], dtype=np.float32) if name == "af_heart" else np.array([0.0, 1.0], dtype=np.float32)
  blended = tts.resolve_kokoro_voice(FakeKokoro(), "af_heart:0.75+af_bella:0.25")
  assert abs(float(blended[0]) - 0.75) < 1e-5 and abs(float(blended[1]) - 0.25) < 1e-5
  numpy_checked = True
except ModuleNotFoundError:
  pass

print(json.dumps({
  "spoken": spoken,
  "sentences": sentences,
  "loudnorm": loudnorm,
  "stems": stems,
  "langs": langs,
  "blendErrorCount": len(blend_errors),
  "openaiErr": openai_err,
  "kokoroErr": kokoro_err,
  "capturedSpoken": captured_spoken,
  "returnedCaption": returned_caption,
  "ffmpegChecked": ffmpeg_checked,
  "shortDuration": short_duration,
  "numpyChecked": numpy_checked,
}))
`
  const out = execFileSync('python3', ['-B', '-c', pythonScript], { encoding: 'utf8' })
  const parsed = JSON.parse(out.trim()) as {
    spoken: Record<string, string>
    sentences: Record<string, string[]>
    loudnorm: Record<string, Record<string, number> | null>
    stems: string[]
    langs: Record<string, string>
    blendErrorCount: number
    openaiErr: string
    kokoroErr: string
    capturedSpoken: string[]
    returnedCaption: string
    ffmpegChecked: boolean
    shortDuration: number | null
    numpyChecked: boolean
  }

  assert.equal(
    parsed.spoken.basic,
    'Check pull request commit hash with HTTP four oh one on 1080p.'
  )
  assert.equal(
    parsed.spoken.sha256,
    'Verify S H A 256 and S H A 1 digests without corrupting commit SHA hash.'
  )
  assert.equal(
    parsed.spoken.cli,
    'Run C L I command for T R P C oh-auth jay-son sequel A P I U R L.'
  )

  assert.deepEqual(parsed.sentences.basic, ['First sentence.', 'Second sentence!', 'Third one?'])
  assert.deepEqual(parsed.sentences.abbrevs, [
    'Use e.g. Kokoro or No. 677 vs. robotic speech.',
    'Next beat.',
  ])
  assert.deepEqual(parsed.sentences.ordinal, ['1. Open home.', '2. Click editor.'])
  assert.deepEqual(parsed.sentences.punct, ['Done. ...', 'Next step.'])

  assert.equal(parsed.loudnorm.valid?.input_i, -18.5)
  assert.equal(parsed.loudnorm.lastBlock?.input_i, -16.2)
  assert.equal(parsed.loudnorm.negInf, null)
  assert.equal(parsed.loudnorm.nan, null)
  assert.equal(parsed.loudnorm.outOfRange, null)

  assert.equal(new Set(parsed.stems).size, 3, 'All sanitized stems must be unique')

  assert.equal(parsed.langs.us, 'en-us')
  assert.equal(parsed.langs.gbSingle, 'en-gb')
  assert.equal(parsed.langs.gbBlend, 'en-gb')
  assert.equal(parsed.langs.mixed, 'en-us')
  assert.equal(parsed.blendErrorCount, 5)

  assert.match(parsed.openaiErr, /OPENAI_API_KEY is required/)
  assert.match(parsed.kokoroErr, /setup-kokoro/)
  assert.match(parsed.kokoroErr, /--tts openai/)

  assert.equal(parsed.capturedSpoken[0], 'Inspect pull request commit hash on 1080p.')
  assert.equal(parsed.returnedCaption, 'Inspect PR commit SHA on 1920x1080.')
  if (parsed.ffmpegChecked) {
    assert.ok(
      parsed.shortDuration !== null && parsed.shortDuration >= 0.2 && parsed.shortDuration <= 0.35
    )
  }
})

test('cli.mjs record rejects robotic TTS providers and out-of-range --speed upfront with exit 2', () => {
  const scenarioPath = join(REPO_ROOT, 'dev/pr-video-evidence/scenarios/shots-workspace-demo.mjs')
  const badTts = spawnSync(
    process.execPath,
    [CLI_PATH, 'record', scenarioPath, '--tts', 'espeak-ng'],
    { encoding: 'utf8' }
  )
  assert.equal(badTts.status, 2)
  assert.match(badTts.stderr, /Invalid --tts provider/)

  const badSpeed = spawnSync(
    process.execPath,
    [CLI_PATH, 'record', scenarioPath, '--speed', '9.5'],
    { encoding: 'utf8' }
  )
  assert.equal(badSpeed.status, 2)
  assert.match(badSpeed.stderr, /Invalid --speed/)
})

test('not_applicable is allowed for prose-only changes with equivalent artifacts, but strictly blocked for web UI', () => {
  const naManifest = makeValidRecordedManifest({
    status: 'not_applicable',
    applicationRoutes: [],
    recordings: [],
    notApplicableReason:
      'Documentation-only update to architecture notes with no runtime behavior.',
    equivalentArtifacts: [
      { kind: 'rfc-check', description: 'python3 dev/verify-rfcs.py passed with zero warnings.' },
    ],
  })

  const docsOk = validateManifest(naManifest, {
    headSha: VALID_SHA,
    changedFiles: ['docs/vision.md'],
  })
  assert.equal(docsOk.valid, true, docsOk.errors.join('; '))

  // UI changes cannot bypass with not_applicable (nor with any empty/custom override).
  const uiBlocked = validateManifest(
    { ...naManifest, uiNonApplicableOverride: '' },
    {
      headSha: VALID_SHA,
      changedFiles: ['clients/apps/web/components/platform-shell/Sidebar.tsx'],
    }
  )
  assert.equal(uiBlocked.valid, false)
  assert.ok(uiBlocked.errors.some((e) => /user-facing web UI/.test(e)))

  // Whitespace-only equivalentArtifacts.kind is rejected.
  const blankKind = validateManifest(
    {
      ...naManifest,
      equivalentArtifacts: [{ kind: '   ', description: 'rfc-check passed' }],
    },
    { headSha: VALID_SHA }
  )
  assert.equal(blankKind.valid, false)
  assert.ok(blankKind.errors.some((e) => /equivalentArtifacts\[0\]/.test(e)))
})

test('unresolved P0/P1 findings, invalid reviewers, missing counts, or mismatched review SHA fail validation', () => {
  const badReview = makeValidRecordedManifest({
    review: {
      reviewedCommitSha: STALE_SHA,
      reviewers: [null, {}],
      findingsBySeverity: { P0: 1, P1: 2, P2: -1 },
      recommendation: 'no-ship',
    },
  })
  const res = validateManifest(badReview, { headSha: VALID_SHA })
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => /reviewedCommitSha/.test(e)))
  assert.ok(res.errors.some((e) => /review\.reviewers\[0\]/.test(e)))
  assert.ok(res.errors.some((e) => /review\.reviewers\[1\]/.test(e)))
  assert.ok(res.errors.some((e) => /Unresolved P0/.test(e)))
  assert.ok(res.errors.some((e) => /Unresolved P1/.test(e)))
  assert.ok(res.errors.some((e) => /findingsBySeverity\.P2/.test(e)))
  assert.ok(res.errors.some((e) => /findingsBySeverity\.P3/.test(e)))
  assert.ok(res.errors.some((e) => /recommendation/.test(e)))

  // Rendering a manifest with malformed reviewer entry does not throw.
  assert.doesNotThrow(() => renderPrEvidenceMarkdown(badReview))
})

test('secret detection catches OpenAI/Stripe/GitHub keys and credentialed video URLs without flagging SHAs', () => {
  assert.deepEqual(detectSensitiveData(`Commit ${VALID_SHA} verified cleanly.`), [])
  assert.ok(detectSensitiveData('token ghp_1234567890abcdefghij123456').includes('GitHub PAT'))
  assert.ok(
    detectSensitiveData('sk-proj-AbCdEf123456_7890-XyZwVuTsRqPoNmLk').includes('OpenAI API key')
  )
  assert.ok(
    detectSensitiveData('whsec_1234567890abcdefghij123456').includes('Stripe webhook secret')
  )
  assert.ok(detectSensitiveData('OPENAI_API_KEY=sk-test-something').length > 0)
  assert.ok(detectSensitiveData('STUDIO_DEV_PASSWORD=dev-supersecret').length > 0)

  assert.equal(isAccessibleVideoUrl('https://github.com/user-attachments/assets/abc'), true)
  assert.equal(
    isAccessibleVideoUrl('https://user:secret@github.com/user-attachments/assets/abc'),
    false
  )
  assert.equal(isAccessibleVideoUrl('https://example.com/demo.mp4'), false)
  assert.equal(isAccessibleVideoUrl('http://localhost:3000/demo.mp4'), false)

  // Secrets in PR body prose outside manifest also fail validation.
  const proseLeak = validatePrEvidence({
    prBody: `Debug key: sk-proj-AbCdEf123456_7890-XyZwVuTsRqPoNmLk\n\n${renderPrEvidenceMarkdown(makeValidRecordedManifest())}`,
    headSha: VALID_SHA,
    prNumber: 677,
    repository: 'PlaybookMediaLLC/shots',
    headRepo: 'PlaybookMediaLLC/shots',
  })
  assert.equal(proseLeak.ok, false)
  assert.ok(proseLeak.errors.some((e) => /PR body/.test(e)))
})

test('extractManifestFromPrBody handles empty, missing, duplicate, unclosed, and invalid JSON blocks', () => {
  assert.equal(extractManifestFromPrBody('').found, false)
  assert.equal(extractManifestFromPrBody('Plain PR description').found, false)
  assert.match(
    extractManifestFromPrBody(`${EVIDENCE_BLOCK_START}\nno end`).error ?? '',
    /Missing closing/
  )
  assert.match(
    extractManifestFromPrBody(
      `${EVIDENCE_BLOCK_START}\na\n${EVIDENCE_BLOCK_END}\n${EVIDENCE_BLOCK_START}\nb\n${EVIDENCE_BLOCK_END}`
    ).error ?? '',
    /multiple pr-video-evidence blocks/
  )
  assert.match(
    extractManifestFromPrBody(
      `${EVIDENCE_BLOCK_START}\n\`\`\`json pr-video-evidence\n{bad json\n\`\`\`\n${EVIDENCE_BLOCK_END}`
    ).error ?? '',
    /Invalid JSON/
  )
})

test('upsertPrEvidenceBlock inserts once, handles stray earlier closing markers, and rejects unclosed blocks', () => {
  const block1 = `${EVIDENCE_BLOCK_START}\nfirst\n${EVIDENCE_BLOCK_END}`
  const block2 = `${EVIDENCE_BLOCK_START}\nsecond\n${EVIDENCE_BLOCK_END}`
  const inserted = upsertPrEvidenceBlock('Summary of PR', block1)
  assert.equal(inserted, `Summary of PR\n\n${block1}`)
  const replaced = upsertPrEvidenceBlock(`${inserted}\n\nFooter note`, block2)
  assert.equal(replaced, `Summary of PR\n\n${block2}\n\nFooter note`)

  // A stray closing marker mentioned in prose before the real block must not cause duplication.
  const proseWithEnd = `Docs mention ${EVIDENCE_BLOCK_END} here.\n\n${block1}`
  const updated = upsertPrEvidenceBlock(proseWithEnd, block2)
  assert.equal(updated.split(EVIDENCE_BLOCK_START).length - 1, 1)
  assert.match(updated, /second/)

  // An unclosed start marker throws instead of appending a duplicate block.
  assert.throws(() => upsertPrEvidenceBlock(`Intro\n\n${EVIDENCE_BLOCK_START}\nunclosed`, block2))
})

test('automated release exemptions require same-repository head and narrow file scopes', () => {
  assert.equal(
    checkAutomatedPrExemption({
      baseRef: 'main',
      headRef: 'develop',
      headRepo: 'PlaybookMediaLLC/shots',
      repository: 'PlaybookMediaLLC/shots',
      changedFiles: ['a.ts'],
    }).exempt,
    true
  )
  // Fork PR cannot spoof develop -> main exemption.
  assert.equal(
    checkAutomatedPrExemption({
      baseRef: 'main',
      headRef: 'develop',
      headRepo: 'attacker/shots',
      repository: 'PlaybookMediaLLC/shots',
      changedFiles: ['a.ts'],
    }).exempt,
    false
  )
  assert.equal(
    checkAutomatedPrExemption({
      baseRef: 'develop',
      headRef: 'release-please--branches--develop',
      headRepo: 'PlaybookMediaLLC/shots',
      repository: 'PlaybookMediaLLC/shots',
      changedFiles: ['CHANGELOG.md', 'package.json'],
    }).exempt,
    true
  )
  // Fork PR cannot spoof release-please exemption.
  assert.equal(
    checkAutomatedPrExemption({
      baseRef: 'develop',
      headRef: 'release-please--branches--develop',
      headRepo: 'attacker/shots',
      repository: 'PlaybookMediaLLC/shots',
      changedFiles: ['CHANGELOG.md', 'package.json'],
    }).exempt,
    false
  )
  assert.equal(
    checkAutomatedPrExemption({
      baseRef: 'develop',
      headRef: 'release-please--branches--develop',
      headRepo: 'PlaybookMediaLLC/shots',
      repository: 'PlaybookMediaLLC/shots',
      changedFiles: ['CHANGELOG.md', 'server/cmd/product-api/main.go'],
    }).exempt,
    false
  )
})

test('caption wrapping, multi-chunk splitting, probe duration parsing, and cue sanitization work cleanly', () => {
  assert.equal(formatTimestamp(0), '00:00')
  assert.equal(formatTimestamp(75.8), '01:15')
  assert.equal(formatSrtTime(61.25), '00:01:01,250')
  assert.equal(formatVttTime(61.25), '00:01:01.250')
  assert.equal(parseProbeDuration('N/A'), 0)
  assert.equal(parseProbeDuration(undefined), 0)
  assert.equal(parseProbeDuration('12.5'), 12.5)
  assert.equal(sanitizeFileStem('../api/health', 0), 'api_health')
  assert.equal(sanitizeFileStem('..', 2), 'beat-03')

  const longText =
    'First we open the live Screenshot Studio workspace and confirm the Pro plan loads cleanly. Next we navigate to the editor, click Export, and confirm the dialog opens without errors.'
  const chunks = wrapCaptionText(longText, 40)
  assert.ok(chunks.length >= 2, 'long cue must split into multiple 2-line chunks')
  for (const chunk of chunks) {
    assert.ok(chunk.split('\n').length <= 2)
  }

  const built = buildCaptionsAndTranscript([
    { audioStartSec: 1.0, audioDurationSeconds: 6.0, text: longText },
  ])
  assert.match(built.srt, /^1\n00:00:01,000 --> /)
  assert.match(built.srt, /\n2\n/)
  assert.match(built.srt, / --> 00:00:07,000\n/)
  assert.match(built.vtt, /^WEBVTT\n\n00:00:01\.000 --> /)
  assert.match(built.transcript, /^\[00:00:01\.000\] First we open/)

  assert.throws(() => assertValidCues([]))
  assert.throws(() =>
    assertValidCues([
      { id: 'dup', text: 'One' },
      { id: 'dup', text: 'Two' },
    ])
  )
  assert.throws(() => assertValidCues([{ id: 'empty', text: '   ' }]))
  assert.throws(() => new EvidenceRecorder({ outDir: '/tmp/ev', baseUrl: 'not-a-url' }))
  assert.throws(() => measureAudioVolume('/nonexistent/file/path.mp4'))
})

test('CLI validate and render-markdown enforce freshness, support --flag=value, and reject invalid flags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-video-evidence-'))
  try {
    const manifestPath = join(dir, 'manifest.json')
    const bodyPath = join(dir, 'body.md')
    const emptyBodyPath = join(dir, 'empty.md')
    const filesPath = join(dir, 'files.txt')
    writeFileSync(manifestPath, JSON.stringify(makeValidRecordedManifest()), 'utf8')
    writeFileSync(filesPath, 'dev/pr-video-evidence/cli.mjs\n', 'utf8')
    writeFileSync(emptyBodyPath, 'Just a PR summary without evidence.\n', 'utf8')

    // render-markdown writes a valid block with --upsert-body
    execFileSync(
      process.execPath,
      [CLI_PATH, 'render-markdown', manifestPath, '--upsert-body', bodyPath],
      { encoding: 'utf8' }
    )

    // validate passes with --key=value syntax and tricky branch characters
    const passRes = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        'validate',
        `--pr-body-file=${bodyPath}`,
        `--head-sha=${VALID_SHA}`,
        '--pr-number=677',
        '--base-ref=develop',
        '--head-ref=fix/$price-$(id)',
        '--head-repo=PlaybookMediaLLC/shots',
        '--repo=PlaybookMediaLLC/shots',
        `--changed-files=${filesPath}`,
      ],
      { encoding: 'utf8' }
    )
    assert.equal(passRes.status, 0, passRes.stderr)
    assert.match(passRes.stdout, /pr-video-evidence PASS/)

    // stale SHA exits 1 with Stale evidence diagnostic
    const staleRes = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        'validate',
        '--pr-body-file',
        bodyPath,
        '--head-sha',
        STALE_SHA,
        '--base-ref',
        'develop',
        '--head-ref',
        'feat/demo',
        '--head-repo',
        'PlaybookMediaLLC/shots',
        '--repo',
        'PlaybookMediaLLC/shots',
      ],
      { encoding: 'utf8' }
    )
    assert.equal(staleRes.status, 1)
    assert.match(staleRes.stderr, /Stale evidence/)

    // missing evidence exits 1 with missing marker diagnostic
    const missingRes = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        'validate',
        '--pr-body-file',
        emptyBodyPath,
        '--head-sha',
        VALID_SHA,
        '--draft',
        'true',
        '--repo',
        'PlaybookMediaLLC/shots',
        '--head-repo',
        'PlaybookMediaLLC/shots',
      ],
      { encoding: 'utf8' }
    )
    assert.equal(missingRes.status, 1)
    assert.match(missingRes.stderr, /Missing <!-- pr-video-evidence:start -->/)

    // invalid --pr-number exits 2 instead of silently disabling PR number check
    const badPrNum = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        'validate',
        '--pr-body-file',
        bodyPath,
        '--head-sha',
        VALID_SHA,
        '--pr-number',
        'abc',
      ],
      { encoding: 'utf8' }
    )
    assert.equal(badPrNum.status, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pr-video-evidence workflow is injection-safe, checks out trusted base, keeps skill copies in sync, and does not activate merge-blocking yet', () => {
  const wf = readFileSync(join(REPO_ROOT, '.github/workflows/pr-video-evidence.yml'), 'utf8')
  assert.match(wf, /^ {4}name: pr-video-evidence$/m)
  assert.match(wf, /ready_for_review/)
  assert.match(wf, /merge_group:/)
  assert.match(wf, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/)
  assert.match(wf, /node dev\/pr-video-evidence\/cli\.mjs validate/)

  // Prevent shell injection: never interpolate steps.pr.outputs.* or github.event.* inside run: blocks.
  for (const runBlock of wf.matchAll(/run: \|\n((?: {10}.*\n)+)/g)) {
    assert.doesNotMatch(
      runBlock[1]!,
      /\$\{\{\s*(?:steps\.pr\.outputs|github\.event)/,
      'Pass PR metadata through env:, never via ${{ ... }} inside bash run:'
    )
  }

  // Keep .agents/skills and .claude/skills copies byte-identical.
  const agentsSkill = readFileSync(
    join(REPO_ROOT, '.agents/skills/pr-video-evidence/SKILL.md'),
    'utf8'
  )
  const claudeSkill = readFileSync(
    join(REPO_ROOT, '.claude/skills/pr-video-evidence/SKILL.md'),
    'utf8'
  )
  assert.equal(agentsSkill, claudeSkill)

  // Do not activate merge-blocking branch protection until tested and explicitly approved.
  const developRuleset = JSON.parse(
    readFileSync(join(REPO_ROOT, '.github/rulesets/develop.json'), 'utf8')
  )
  const contexts = developRuleset.rules
    .find((r: { type: string }) => r.type === 'required_status_checks')
    .parameters.required_status_checks.map((c: { context: string }) => c.context)
  assert.equal(contexts.includes('pr-video-evidence'), false)
})
