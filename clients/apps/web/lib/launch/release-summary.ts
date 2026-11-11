import type { ReleaseSpecContent, SpecSource } from '@/lib/launch/spec-schema'

/**
 * The summary a release's posts are written from: its approved launch spec's
 * summary, else its newest spec's, else the release brief. `verified` is
 * false while no person has verified it, so a draft written from it says so:
 * AI drafts facts, it never approves them.
 */
export type ReleaseSummary = {
  source: 'release' | 'spec'
  text: string
  verified: boolean
}

/** The working spec (approved, else newest) of a release, as the launch store reads it. */
type WorkingSpec = {
  approvedAt: Date | null
  content: Pick<ReleaseSpecContent, 'summary'>
  sources: SpecSource[]
}

/** The summary to write a release's posts from, or null when there is no text to write from. */
export function releaseSummary(input: {
  benefitStatement: string
  spec: WorkingSpec | null
}): ReleaseSummary | null {
  const spec = input.spec
  // The brief is the release's own text, written by a person or taken from its notes.
  if (!spec) {
    const text = input.benefitStatement.trim()
    return text ? { source: 'release', text, verified: true } : null
  }
  const summary = spec.content.summary
  if (!summary.text.trim()) return null
  // A spec no one approved, or a summary resting on a source that could not
  // be read or was flagged as an injection attempt, stays unverified.
  const sound = summary.sources
    .filter((ref) => ref !== 'brief')
    .every((ref) => {
      const source = spec.sources.find((item) => item.id === ref)
      return source !== undefined && source.status === 'ok' && !source.flagged
    })
  return { source: 'spec', text: summary.text, verified: Boolean(spec.approvedAt) && sound }
}

/** The captions request's notes field holds this many characters. */
const NOTES_LIMIT = 1_000

/**
 * The writer's notes that ask for captions from the summary. A summary too
 * long for the notes is cut at a word, so no number or name is left half
 * written for the model to state.
 */
export function releaseCaptionNotes(summary: ReleaseSummary): string {
  const lead = summary.verified
    ? 'Write from this release summary: '
    : 'Write from this release summary. No person has verified it yet: state nothing it does not say. Summary: '
  const room = NOTES_LIMIT - lead.length
  if (summary.text.length <= room) return lead + summary.text
  const cut = summary.text.slice(0, room - 1)
  const end = cut.lastIndexOf(' ')
  return `${lead}${(end > 0 ? cut.slice(0, end) : cut).trimEnd()}…`
}

/** The draft's note of what to verify before approval; empty for a verified summary. */
export function releaseClaimsNote(summary: ReleaseSummary | null): string {
  return summary && !summary.verified ? `Claims to verify before approval:\n- ${summary.text}` : ''
}
