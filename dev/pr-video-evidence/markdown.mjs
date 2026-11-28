// Renders the PR description evidence summary block (matching pr-video-evidence
// SKILL.md §16) and embeds the machine-verified JSON manifest for CI validation.

import { EVIDENCE_BLOCK_END, EVIDENCE_BLOCK_START } from './schema.mjs'

/**
 * Escape Markdown table cell pipes and newlines.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

/**
 * Format seconds as MM:SS.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatTimestamp(seconds) {
  const clamped = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(clamped / 60)
  const secs = clamped % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

/**
 * Format a single recording metadata line for the PR summary.
 *
 * @param {Record<string, unknown>} rec
 * @returns {string}
 */
function formatRecordingLine(rec) {
  const title = rec.title || 'Playable demonstration'
  const link = rec.videoUrl
    ? `[${title}](${rec.videoUrl})`
    : `${title} (attach video URL before marking ready)`
  return `${link} (${Math.round(Number(rec.durationSeconds || 0))}s, ${rec.width}x${rec.height} @ ${rec.fps}fps, ${rec.videoCodec}/${rec.audioCodec}, TTS: ${rec.ttsProvider})`
}

/**
 * Render the canonical PR video evidence markdown block.
 *
 * @param {Record<string, unknown>} manifest
 * @returns {string}
 */
export function renderPrEvidenceMarkdown(manifest) {
  const lines = [EVIDENCE_BLOCK_START, '### Narrated verification']

  if (manifest.status === 'recorded') {
    const recordings = /** @type {Array<Record<string, unknown>>} */ (manifest.recordings ?? [])
    if (recordings.length === 1) {
      lines.push(`Recording: ${formatRecordingLine(recordings[0])}`)
    } else {
      lines.push('Recordings:')
      for (const rec of recordings) {
        lines.push(`- ${formatRecordingLine(rec)}`)
      }
    }
  } else {
    lines.push(`Recording: Not applicable — ${manifest.notApplicableReason}`)
  }

  lines.push(`Commit: \`${manifest.commitSha}\``)
  lines.push(`Environment: \`${manifest.testEnvironment}\``)
  if (Array.isArray(manifest.applicationRoutes) && manifest.applicationRoutes.length > 0) {
    lines.push(
      `Routes / targets: ${manifest.applicationRoutes.map((route) => `\`${route}\``).join(', ')}`
    )
  }

  lines.push('', '### Demonstrated behavior', '')
  lines.push('| Acceptance criterion | Timestamp | Verification |')
  lines.push('| --- | --- | --- |')
  const criteria = /** @type {Array<Record<string, unknown>>} */ (manifest.acceptanceCriteria ?? [])
  for (const ac of criteria) {
    const label = ac.id ? `**${ac.id}**: ${ac.description}` : String(ac.description ?? '')
    const ts = ac.timestampRange ? String(ac.timestampRange) : 'N/A'
    const status = ac.verified ? 'Passed' : 'Pending'
    lines.push(`| ${escapeCell(label)} | ${escapeCell(ts)} | ${status} |`)
  }

  lines.push('', '### Automated checks', '')
  const assertions = /** @type {Array<Record<string, unknown>>} */ (manifest.assertionResults ?? [])
  for (const res of assertions) {
    const icon = res.status === 'passed' ? 'PASS' : res.status === 'failed' ? 'FAIL' : 'SKIP'
    lines.push(`- **${icon}** \`${res.command}\` (${res.suite}): ${res.summary}`)
  }

  if (manifest.status === 'not_applicable' && Array.isArray(manifest.equivalentArtifacts)) {
    lines.push('', '### Equivalent verification artifacts', '')
    for (const art of /** @type {Array<Record<string, unknown>>} */ (
      manifest.equivalentArtifacts
    )) {
      const ref = art.reference ? ` (${art.reference})` : ''
      lines.push(`- **${art.kind}**: ${art.description}${ref}`)
    }
  }

  if (manifest.review && typeof manifest.review === 'object' && !Array.isArray(manifest.review)) {
    const review = /** @type {Record<string, unknown>} */ (manifest.review)
    const reviewers = Array.isArray(review.reviewers)
      ? review.reviewers.filter((r) => r && typeof r === 'object')
      : []
    const counts = /** @type {Record<string, number>} */ (review.findingsBySeverity ?? {})
    lines.push('', '### Independent engineering review', '')
    lines.push(
      `- **Recommendation:** ${String(review.recommendation ?? '').toUpperCase()} (reviewed \`${String(review.reviewedCommitSha ?? '').slice(0, 12)}\`)`
    )
    lines.push(
      `- **Reviewers:** ${reviewers.map((r) => `${r.id}${r.perspective ? ` (${r.perspective})` : ''}`).join(', ')}`
    )
    lines.push(
      `- **Unresolved findings:** P0: ${counts.P0 ?? 0}, P1: ${counts.P1 ?? 0}, P2: ${counts.P2 ?? 0}, P3: ${counts.P3 ?? 0}`
    )
  }

  lines.push('', '### Known limitations', '')
  const limitations = /** @type {string[]} */ (
    Array.isArray(manifest.knownLimitations) && manifest.knownLimitations.length > 0
      ? manifest.knownLimitations
      : ['None observed in the verified environment.']
  )
  for (const item of limitations) {
    lines.push(`- ${item}`)
  }

  lines.push(
    '',
    '<details>',
    '<summary>Evidence manifest (machine-verified)</summary>',
    '',
    '```json pr-video-evidence',
    JSON.stringify(manifest, null, 2),
    '```',
    '</details>',
    EVIDENCE_BLOCK_END
  )

  return lines.join('\n')
}

/**
 * Insert or replace the PR video evidence block in an existing PR body while
 * preserving all surrounding PR description content.
 *
 * @param {string} existingBody
 * @param {string} evidenceMarkdown
 * @returns {string}
 */
export function upsertPrEvidenceBlock(existingBody, evidenceMarkdown) {
  const body = typeof existingBody === 'string' ? existingBody : ''
  const startIdx = body.indexOf(EVIDENCE_BLOCK_START)

  if (startIdx !== -1) {
    const endIdx = body.indexOf(EVIDENCE_BLOCK_END, startIdx + EVIDENCE_BLOCK_START.length)
    if (endIdx === -1) {
      throw new Error(
        `Existing PR body has an unclosed ${EVIDENCE_BLOCK_START} marker; add ${EVIDENCE_BLOCK_END} before updating.`
      )
    }
    const before = body.slice(0, startIdx).trimEnd()
    const after = body.slice(endIdx + EVIDENCE_BLOCK_END.length).trimStart()
    return [before, evidenceMarkdown, after].filter(Boolean).join('\n\n')
  }

  const trimmed = body.trimEnd()
  return trimmed.length > 0 ? `${trimmed}\n\n${evidenceMarkdown}` : evidenceMarkdown
}
