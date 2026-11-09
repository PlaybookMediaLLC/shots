import assert from 'node:assert/strict'
import test from 'node:test'
import { enforceCitations, findCitationIssues } from '@/lib/launch/citations'
import {
  claimsMeanTheSame,
  isRegisteredCaptureUrl,
  listSpecClaims,
  releaseSpecSchema,
  resolveClaimRef,
  validatePlanReferences,
} from '@/lib/launch/spec-schema'
import { samplePlan, sampleSpec } from './launch-fixtures'
import {
  formatPillars,
  formatSection,
  parsePillars,
  parsePositioning,
  parseSection,
  TEXT_SECTIONS,
} from '@/lib/launch/spec-text'

test('the spec schema fills defaults and rejects uncited claims', () => {
  const spec = sampleSpec()
  assert.equal(spec.openQuestions[0]!.answer, '')
  const uncited = releaseSpecSchema.safeParse({
    ...spec,
    problem: [{ sources: [], text: 'No source' }],
  })
  assert.equal(uncited.success, false)
  const badRef = releaseSpecSchema.safeParse({ ...spec, problem: [{ sources: ['S0'], text: 'x' }] })
  assert.equal(badRef.success, false)
})

test('claim refs resolve to the claims they name', () => {
  const spec = sampleSpec()
  assert.equal(
    resolveClaimRef(spec, 'capabilities.1')?.text,
    'Smart retries: Retry failed payments automatically'
  )
  assert.equal(resolveClaimRef(spec, 'messaging.pillars.0')?.section, 'messaging')
  assert.equal(resolveClaimRef(spec, 'capabilities.5'), null)
  assert.ok(listSpecClaims(spec).some((claim) => claim.ref === 'messaging.positioning'))
})

test('citation checks catch sources the model was not given', () => {
  const spec = sampleSpec()
  assert.deepEqual(findCitationIssues(spec, new Set(['S1', 'S2'])), [])
  const issues = findCitationIssues(spec, new Set(['S1']))
  assert.equal(issues.length, 2, 'the capability and the FAQ cite S2')
  assert.match(issues[0]!, /cites S2, which is not a source/)
})

test('enforcing citations turns unsupported claims into open questions', () => {
  const { moved, spec } = enforceCitations(sampleSpec(), new Set(['S1']))
  assert.equal(moved, 2)
  assert.equal(spec.capabilities.length, 1)
  assert.equal(spec.faqs.length, 0)
  assert.ok(spec.openQuestions.some((question) => question.question.includes('Smart retries')))
  // A claim with one good and one bad citation keeps the good one.
  const mixed = sampleSpec()
  mixed.whatChanged[0]!.sources = ['S1', 'S9']
  assert.deepEqual(enforceCitations(mixed, new Set(['S1', 'S2'])).spec.whatChanged[0]!.sources, [
    'S1',
  ])
})

test('every text section round-trips through the editing format', () => {
  const spec = sampleSpec()
  for (const section of TEXT_SECTIONS) {
    const parsed = parseSection(section, formatSection(spec, section))
    assert.ok(parsed.ok, `${section}: ${parsed.ok ? '' : parsed.errors.join('; ')}`)
    assert.deepEqual(parsed.value, spec[section], section)
  }
  const pillars = parsePillars(formatPillars(spec))
  assert.ok(pillars.ok)
  assert.deepEqual(pillars.value, spec.messaging.pillars)
})

test('the editing format names the line that is missing a citation', () => {
  const result = parseSection('problem', 'Cited line [S1]\nUncited line')
  assert.equal(result.ok, false)
  assert.match((result as { errors: string[] }).errors[0]!, /^Line 2: add sources/)
  const bad = parseSection('capabilities', 'No separator here [S1]')
  assert.equal(bad.ok, false)
  const invalid = parseSection('whatChanged', 'Claim [S1, website]')
  assert.match((invalid as { errors: string[] }).errors[0]!, /"website" is not a source/)
  assert.deepEqual(parsePositioning(''), { ok: true, value: { sources: [], statement: '' } })
})

test('plan references must point at angles, assets, channels, claims, and registered URLs', () => {
  const spec = sampleSpec()
  const plan = samplePlan()
  assert.deepEqual(validatePlanReferences(plan, spec, []), [])
  const broken = {
    ...plan,
    angles: [{ ...plan.angles[0]!, specRefs: ['capabilities.9'] }],
    assets: [
      {
        ...plan.assets[0]!,
        captureHint: { ...plan.assets[0]!.captureHint, url: 'https://evil.example' },
      },
    ],
    timeline: [
      {
        ...plan.timeline[0]!,
        assetKeys: ['A7'],
        channel: 'x' as const,
        day: 3,
        phase: 'launch' as const,
      },
    ],
  }
  const issues = validatePlanReferences(broken, spec, ['https://app.ledgerly.example'])
  assert.equal(issues.length, 5)
  assert.ok(issues.some((issue) => issue.includes('capabilities.9')))
  assert.ok(issues.some((issue) => issue.includes('not a registered URL')))
  assert.ok(issues.some((issue) => issue.includes('phase is follow_up')))
})

test('capture URLs may add a section fragment but never change the page', () => {
  const allowed = ['https://nextjs.org/blog/next-15']
  assert.ok(isRegisteredCaptureUrl('https://nextjs.org/blog/next-15', allowed))
  assert.ok(isRegisteredCaptureUrl('https://nextjs.org/blog/next-15#async-request-apis', allowed))
  assert.equal(isRegisteredCaptureUrl('https://nextjs.org/blog/next-16#x', allowed), false)
  assert.equal(
    isRegisteredCaptureUrl('https://nextjs.org/blog/next-15#a"><script>', allowed),
    false
  )
  assert.equal(
    isRegisteredCaptureUrl('https://evil.example/#https://nextjs.org/blog/next-15', allowed),
    false
  )
})

test('claims from an earlier spec version count only while they still say the same thing', () => {
  const v1 = sampleSpec()
  // A redraft that keeps the pillar and rewrites a capability.
  const v2 = {
    ...v1,
    capabilities: v1.capabilities.map((capability, index) =>
      index === 0 ? { ...capability, description: 'Rewritten in the redraft' } : capability
    ),
  }
  assert.equal(claimsMeanTheSame(['messaging.pillars.0', 'summary'], v1, v2), true)
  assert.equal(claimsMeanTheSame(['messaging.pillars.0', 'capabilities.0'], v1, v2), false)
  // A ref the later version no longer has does not carry over.
  assert.equal(claimsMeanTheSame(['problem.9'], v1, v2), false)
})
