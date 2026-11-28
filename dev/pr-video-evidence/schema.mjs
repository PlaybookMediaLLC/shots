// Evidence manifest schema, redaction guard, and PR validation for Shots
// narrated PR video evidence. Zero external dependencies so it runs identically
// in local Node 22 and in GitHub Actions without npm ci.

export const EVIDENCE_SCHEMA_VERSION = 1
export const EVIDENCE_BLOCK_START = '<!-- pr-video-evidence:start -->'
export const EVIDENCE_BLOCK_END = '<!-- pr-video-evidence:end -->'

const SHA_PATTERN = /^[0-9a-f]{40}$/
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const PLACEHOLDER_HOST_PATTERN =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|example\.com|example\.org|example\.net|tbd|todo)$/i

/**
 * Patterns that must never appear in PR evidence manifests, transcripts, or
 * rendered PR summaries. Kept intentionally specific to avoid false positives
 * on commit SHAs and normal prose.
 */
export const SECRET_PATTERNS = [
  { name: 'GitHub PAT', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  {
    name: 'Stripe secret/restricted key',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{16,}\b/,
  },
  { name: 'Stripe webhook secret', pattern: /\bwhsec_[A-Za-z0-9]{20,}\b/ },
  { name: 'OpenAI API key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private key header', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  {
    name: 'Inline secret assignment',
    pattern:
      /\b(?:STUDIO_DEV_PASSWORD|POSTGRES_APP_PASSWORD|BETTER_AUTH_SECRET|OPENAI_API_KEY)=\S+/,
  },
]

/**
 * User-facing web UI paths that always require a real browser recording rather
 * than `status: "not_applicable"`.
 */
export const USER_FACING_UI_PATTERNS = [
  /^clients\/apps\/web\/app\/(?!api\/)/,
  /^clients\/apps\/web\/components\//,
]

const VALID_VIDEO_CODECS = new Set(['h264', 'avc1'])
const VALID_AUDIO_CODECS = new Set(['aac'])
const VALID_ASSERTION_STATUSES = new Set(['passed', 'failed', 'skipped'])

/**
 * Scan arbitrary text for sensitive credential patterns.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function detectSensitiveData(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const hits = []
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) hits.push(name)
  }
  return hits
}

/**
 * True when `value` is a valid non-local HTTPS URL without embedded credentials.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAccessibleVideoUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  if (!parsed.hostname || PLACEHOLDER_HOST_PATTERN.test(parsed.hostname)) return false
  if (parsed.hostname.endsWith('.local') || parsed.hostname.endsWith('.test')) return false
  return true
}

/**
 * True when a same-repository automated release PR aggregates already-verified
 * commits (develop -> main release promotion or Release Please metadata-only
 * version/changelog bump). Fork PRs are never exempt.
 *
 * @param {{
 *   baseRef?: string,
 *   headRef?: string,
 *   headRepo?: string,
 *   repository?: string,
 *   changedFiles?: string[],
 * }} input
 * @returns {{ exempt: boolean, reason?: string }}
 */
export function checkAutomatedPrExemption({
  baseRef,
  headRef,
  headRepo,
  repository,
  changedFiles,
}) {
  const sameRepo =
    Boolean(headRepo) &&
    Boolean(repository) &&
    String(headRepo).toLowerCase() === String(repository).toLowerCase()
  if (!sameRepo) return { exempt: false }

  if (baseRef === 'main' && headRef === 'develop') {
    return {
      exempt: true,
      reason:
        'Release promotion from develop to main (constituent PRs already verified on develop).',
    }
  }
  if (typeof headRef === 'string' && headRef.startsWith('release-please--')) {
    const files = (changedFiles ?? []).filter(Boolean)
    const releaseOnly =
      files.length > 0 &&
      files.every((file) =>
        /^(CHANGELOG\.md|package\.json|\.release-please-manifest\.json)$/.test(file)
      )
    if (releaseOnly) {
      return {
        exempt: true,
        reason: 'Release Please version/changelog bump touching only release metadata files.',
      }
    }
  }
  return { exempt: false }
}

/**
 * Extract the fenced `json pr-video-evidence` manifest from a PR description.
 *
 * @param {string} prBody
 * @returns {{ found: boolean, manifest?: unknown, block?: string, error?: string }}
 */
export function extractManifestFromPrBody(prBody) {
  if (typeof prBody !== 'string' || prBody.trim().length === 0) {
    return { found: false, error: 'Pull request description is empty.' }
  }
  const startIdx = prBody.indexOf(EVIDENCE_BLOCK_START)
  if (startIdx === -1) {
    return {
      found: false,
      error: `Missing ${EVIDENCE_BLOCK_START} section in pull request description.`,
    }
  }
  const secondStart = prBody.indexOf(EVIDENCE_BLOCK_START, startIdx + EVIDENCE_BLOCK_START.length)
  if (secondStart !== -1) {
    return {
      found: false,
      error:
        'Pull request description contains multiple pr-video-evidence blocks; keep exactly one.',
    }
  }
  const endIdx = prBody.indexOf(EVIDENCE_BLOCK_END, startIdx + EVIDENCE_BLOCK_START.length)
  if (endIdx === -1) {
    return {
      found: false,
      error: `Missing closing ${EVIDENCE_BLOCK_END} marker in pull request description.`,
    }
  }
  const block = prBody.slice(startIdx, endIdx + EVIDENCE_BLOCK_END.length)
  const jsonMatch = block.match(/```json\s+pr-video-evidence\s*\r?\n([\s\S]*?)\r?\n```/)
  if (!jsonMatch) {
    return {
      found: false,
      block,
      error: 'Missing ```json pr-video-evidence manifest code block inside evidence section.',
    }
  }
  try {
    const manifest = JSON.parse(jsonMatch[1])
    return { found: true, manifest, block }
  } catch (err) {
    return {
      found: false,
      block,
      error: `Invalid JSON in pr-video-evidence manifest: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Validate a parsed evidence manifest object.
 *
 * @param {unknown} manifest
 * @param {{
 *   headSha?: string,
 *   prNumber?: number | null,
 *   repository?: string,
 *   changedFiles?: string[],
 *   requireVideoUrl?: boolean,
 * }} [context]
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateManifest(manifest, context = {}) {
  const errors = []
  const warnings = []
  const requireVideoUrl = context.requireVideoUrl !== false

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['Evidence manifest must be a JSON object.'], warnings }
  }

  const m = /** @type {Record<string, unknown>} */ (manifest)

  if (m.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be ${EVIDENCE_SCHEMA_VERSION} (got ${String(m.schemaVersion)}).`
    )
  }

  if (m.status !== 'recorded' && m.status !== 'not_applicable') {
    errors.push(`status must be "recorded" or "not_applicable" (got ${String(m.status)}).`)
  }

  if (typeof m.repository !== 'string' || !REPO_PATTERN.test(m.repository)) {
    errors.push('repository must be a valid "owner/repo" string.')
  } else if (
    context.repository &&
    m.repository.toLowerCase() !== context.repository.toLowerCase()
  ) {
    errors.push(`repository "${m.repository}" does not match "${context.repository}".`)
  }

  if (typeof m.branch !== 'string' || m.branch.trim().length === 0) {
    errors.push('branch must be a non-empty string.')
  }

  if (typeof m.commitSha !== 'string' || !SHA_PATTERN.test(m.commitSha)) {
    errors.push('commitSha must be an exact 40-character lowercase hex commit SHA.')
  } else if (context.headSha && m.commitSha !== context.headSha) {
    errors.push(
      `Stale evidence: manifest commitSha ${m.commitSha.slice(0, 12)} does not match PR head ${context.headSha.slice(0, 12)}. Regenerate narrated evidence against the current commit.`
    )
  }

  if (m.pullRequestNumber !== null && m.pullRequestNumber !== undefined) {
    if (
      !Number.isInteger(m.pullRequestNumber) ||
      /** @type {number} */ (m.pullRequestNumber) <= 0
    ) {
      errors.push('pullRequestNumber must be a positive integer or null.')
    } else if (context.prNumber && m.pullRequestNumber !== context.prNumber) {
      errors.push(
        `pullRequestNumber #${m.pullRequestNumber} does not match pull request #${context.prNumber}.`
      )
    }
  }

  if (typeof m.capturedAt !== 'string' || Number.isNaN(Date.parse(m.capturedAt))) {
    errors.push('capturedAt must be a valid ISO-8601 timestamp.')
  }

  if (typeof m.testEnvironment !== 'string' || m.testEnvironment.trim().length === 0) {
    errors.push(
      'testEnvironment must be a non-empty string (e.g. "native-stack", "compose-production").'
    )
  }

  if (m.redactionConfirmed !== true) {
    errors.push(
      'redactionConfirmed must be true (confirming no credentials, tokens, financial data, or customer data are exposed).'
    )
  }

  // Acceptance criteria
  if (!Array.isArray(m.acceptanceCriteria) || m.acceptanceCriteria.length === 0) {
    errors.push('acceptanceCriteria must be a non-empty array.')
  } else {
    for (let i = 0; i < m.acceptanceCriteria.length; i++) {
      const ac = m.acceptanceCriteria[i]
      if (!ac || typeof ac !== 'object') {
        errors.push(`acceptanceCriteria[${i}] must be an object.`)
        continue
      }
      if (typeof ac.id !== 'string' || ac.id.trim().length === 0) {
        errors.push(`acceptanceCriteria[${i}].id must be a non-empty string.`)
      }
      if (typeof ac.description !== 'string' || ac.description.trim().length === 0) {
        errors.push(`acceptanceCriteria[${i}].description must be a non-empty string.`)
      }
      if (ac.verified !== true) {
        errors.push(`Acceptance criterion "${ac.id || i}" is not verified (verified !== true).`)
      }
    }
  }

  // Assertion / test results
  if (!Array.isArray(m.assertionResults) || m.assertionResults.length === 0) {
    errors.push('assertionResults must be a non-empty array of executed verification checks.')
  } else {
    let passedCount = 0
    for (let i = 0; i < m.assertionResults.length; i++) {
      const res = m.assertionResults[i]
      if (!res || typeof res !== 'object') {
        errors.push(`assertionResults[${i}] must be an object.`)
        continue
      }
      if (typeof res.suite !== 'string' || res.suite.trim().length === 0) {
        errors.push(`assertionResults[${i}].suite must be a non-empty string.`)
      }
      if (typeof res.command !== 'string' || res.command.trim().length === 0) {
        errors.push(`assertionResults[${i}].command must be a non-empty string.`)
      }
      if (!VALID_ASSERTION_STATUSES.has(res.status)) {
        errors.push(`assertionResults[${i}].status must be "passed", "failed", or "skipped".`)
      } else if (res.status === 'failed') {
        errors.push(
          `Assertion suite "${res.suite || i}" failed; all applicable verification checks must pass.`
        )
      } else if (res.status === 'passed') {
        passedCount++
      }
      if (typeof res.summary !== 'string' || res.summary.trim().length === 0) {
        errors.push(`assertionResults[${i}].summary must be a non-empty string.`)
      }
    }
    if (passedCount === 0) {
      errors.push('assertionResults must include at least one passed verification suite.')
    }
  }

  // Recorded vs not_applicable branches
  if (m.status === 'recorded') {
    if (
      !Array.isArray(m.applicationRoutes) ||
      m.applicationRoutes.length === 0 ||
      !m.applicationRoutes.every((r) => typeof r === 'string' && r.trim().length > 0)
    ) {
      errors.push(
        'applicationRoutes must be a non-empty array of demonstrated routes or backend targets (e.g. ["/home", "/editor"]).'
      )
    }

    if (!Array.isArray(m.recordings) || m.recordings.length === 0) {
      errors.push('recordings must be a non-empty array when status is "recorded".')
    } else {
      for (let i = 0; i < m.recordings.length; i++) {
        const rec = m.recordings[i]
        if (!rec || typeof rec !== 'object') {
          errors.push(`recordings[${i}] must be an object.`)
          continue
        }
        if (typeof rec.title !== 'string' || rec.title.trim().length === 0) {
          errors.push(`recordings[${i}].title must be a non-empty string.`)
        }
        if (requireVideoUrl && !isAccessibleVideoUrl(rec.videoUrl)) {
          errors.push(
            `recordings[${i}].videoUrl must be an accessible non-local https:// URL without embedded credentials (got ${String(rec.videoUrl)}).`
          )
        }
        if (
          typeof rec.durationSeconds !== 'number' ||
          !Number.isFinite(rec.durationSeconds) ||
          rec.durationSeconds <= 0
        ) {
          errors.push(`recordings[${i}].durationSeconds must be a positive number.`)
        } else if (rec.durationSeconds > 180) {
          warnings.push(
            `recordings[${i}] is ${rec.durationSeconds.toFixed(1)}s long; prefer concise 30–120s clips or multiple focused recordings.`
          )
        }
        if (
          !Number.isInteger(rec.width) ||
          rec.width < 1280 ||
          !Number.isInteger(rec.height) ||
          rec.height < 720
        ) {
          errors.push(`recordings[${i}] resolution must be at least 1280x720 (default 1920x1080).`)
        }
        if (typeof rec.fps !== 'number' || !Number.isFinite(rec.fps) || rec.fps < 24) {
          errors.push(`recordings[${i}].fps must be a finite number >= 24 (default 30).`)
        }
        if (
          typeof rec.videoCodec !== 'string' ||
          !VALID_VIDEO_CODECS.has(rec.videoCodec.toLowerCase())
        ) {
          errors.push(`recordings[${i}].videoCodec must be "h264" (got ${String(rec.videoCodec)}).`)
        }
        if (
          typeof rec.audioCodec !== 'string' ||
          !VALID_AUDIO_CODECS.has(rec.audioCodec.toLowerCase())
        ) {
          errors.push(`recordings[${i}].audioCodec must be "aac" (got ${String(rec.audioCodec)}).`)
        }
        if (rec.narrated !== true) {
          errors.push(`recordings[${i}].narrated must be true.`)
        }
        if (rec.captioned !== true) {
          errors.push(`recordings[${i}].captioned must be true.`)
        }
        if (typeof rec.ttsProvider !== 'string' || rec.ttsProvider.trim().length === 0) {
          errors.push(
            `recordings[${i}].ttsProvider must name the TTS provider used (e.g. "kokoro-onnx").`
          )
        }
      }
    }
  } else if (m.status === 'not_applicable') {
    if (typeof m.notApplicableReason !== 'string' || m.notApplicableReason.trim().length < 20) {
      errors.push(
        'notApplicableReason must clearly explain why narrated video evidence is not applicable (at least 20 characters).'
      )
    }
    if (!Array.isArray(m.equivalentArtifacts) || m.equivalentArtifacts.length === 0) {
      errors.push(
        'equivalentArtifacts must list at least one equivalent verification artifact when status is "not_applicable".'
      )
    } else {
      for (let i = 0; i < m.equivalentArtifacts.length; i++) {
        const art = m.equivalentArtifacts[i]
        if (
          !art ||
          typeof art !== 'object' ||
          typeof art.kind !== 'string' ||
          art.kind.trim().length === 0 ||
          typeof art.description !== 'string' ||
          art.description.trim().length === 0
        ) {
          errors.push(
            `equivalentArtifacts[${i}] must include non-empty "kind" and "description" fields.`
          )
        }
      }
    }

    const uiFiles = (context.changedFiles ?? []).filter((file) =>
      USER_FACING_UI_PATTERNS.some((p) => p.test(file))
    )
    if (uiFiles.length > 0) {
      errors.push(
        `status "not_applicable" is not allowed when user-facing web UI files changed (${uiFiles.slice(0, 3).join(', ')}). Record a narrated Playwright demonstration of the running app.`
      )
    }
  }

  // Independent engineering review manifest validation (when present)
  if (m.review !== undefined && m.review !== null) {
    if (typeof m.review !== 'object' || Array.isArray(m.review)) {
      errors.push('review must be an object when provided.')
    } else {
      const r = /** @type {Record<string, unknown>} */ (m.review)
      if (typeof r.reviewedCommitSha !== 'string' || !SHA_PATTERN.test(r.reviewedCommitSha)) {
        errors.push('review.reviewedCommitSha must be a 40-character commit SHA.')
      } else if (typeof m.commitSha === 'string' && r.reviewedCommitSha !== m.commitSha) {
        errors.push(
          `review.reviewedCommitSha (${r.reviewedCommitSha.slice(0, 12)}) does not match manifest commitSha (${m.commitSha.slice(0, 12)}).`
        )
      }
      if (!Array.isArray(r.reviewers) || r.reviewers.length === 0) {
        errors.push('review.reviewers must list the independent reviewers that ran.')
      } else {
        for (let i = 0; i < r.reviewers.length; i++) {
          const rev = r.reviewers[i]
          if (
            !rev ||
            typeof rev !== 'object' ||
            typeof rev.id !== 'string' ||
            rev.id.trim().length === 0
          ) {
            errors.push(`review.reviewers[${i}] must be an object with a non-empty "id" string.`)
          }
        }
      }
      const counts = /** @type {Record<string, unknown> | undefined} */ (r.findingsBySeverity)
      if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
        errors.push('review.findingsBySeverity must report unresolved counts for P0, P1, P2, P3.')
      } else {
        for (const sev of ['P0', 'P1', 'P2', 'P3']) {
          const val = counts[sev]
          if (!Number.isInteger(val) || /** @type {number} */ (val) < 0) {
            errors.push(`review.findingsBySeverity.${sev} must be a non-negative integer.`)
          }
        }
        if (counts.P0 !== 0) {
          errors.push(`Unresolved P0 review findings (${String(counts.P0)}) block readiness.`)
        }
        if (counts.P1 !== 0) {
          errors.push(`Unresolved P1 review findings (${String(counts.P1)}) block readiness.`)
        }
      }
      if (r.recommendation !== 'ship') {
        errors.push(
          `review.recommendation must be "ship" before marking ready (got ${String(r.recommendation)}).`
        )
      }
    }
  }

  // Secret scan over serialized manifest
  const secretHits = detectSensitiveData(JSON.stringify(m))
  if (secretHits.length > 0) {
    errors.push(`Potential secret/credential detected in manifest: ${secretHits.join(', ')}.`)
  }

  return { valid: errors.length === 0, errors, warnings }
}

/**
 * Full pull-request evidence validation used by GitHub Actions and local CLI.
 *
 * @param {{
 *   prBody: string,
 *   headSha: string,
 *   prNumber?: number | null,
 *   baseRef?: string,
 *   headRef?: string,
 *   headRepo?: string,
 *   repository?: string,
 *   isDraft?: boolean,
 *   changedFiles?: string[],
 *   requireVideoUrl?: boolean,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   exempt?: boolean,
 *   reason?: string,
 *   errors: string[],
 *   warnings: string[],
 *   manifest?: Record<string, unknown>,
 * }}
 */
export function validatePrEvidence(input) {
  const exemption = checkAutomatedPrExemption({
    baseRef: input.baseRef,
    headRef: input.headRef,
    headRepo: input.headRepo,
    repository: input.repository,
    changedFiles: input.changedFiles,
  })
  if (exemption.exempt) {
    return { ok: true, exempt: true, reason: exemption.reason, errors: [], warnings: [] }
  }

  if (typeof input.headSha !== 'string' || !SHA_PATTERN.test(input.headSha)) {
    return {
      ok: false,
      errors: [
        `headSha must be a 40-character lowercase hex commit SHA for freshness validation (got "${String(input.headSha ?? '')}").`,
      ],
      warnings: [],
    }
  }

  const bodySecrets = detectSensitiveData(input.prBody ?? '')
  const extracted = extractManifestFromPrBody(input.prBody)
  if (!extracted.found) {
    const errors = [extracted.error ?? 'Missing PR video evidence manifest.']
    if (bodySecrets.length > 0) {
      errors.push(`Potential secret/credential detected in PR body: ${bodySecrets.join(', ')}.`)
    }
    if (input.isDraft) {
      errors.push(
        'Pull request is still a draft. Attach narrated video evidence for the current commit before marking ready for review.'
      )
    }
    return { ok: false, errors, warnings: [] }
  }

  const result = validateManifest(extracted.manifest, {
    headSha: input.headSha,
    prNumber: input.prNumber,
    repository: input.repository,
    changedFiles: input.changedFiles,
    requireVideoUrl: input.requireVideoUrl,
  })

  if (bodySecrets.length > 0) {
    result.errors.push(
      `Potential secret/credential detected in PR body: ${bodySecrets.join(', ')}.`
    )
  }

  return {
    ok: result.errors.length === 0,
    errors: result.errors,
    warnings: result.warnings,
    manifest: /** @type {Record<string, unknown>} */ (extracted.manifest),
  }
}
