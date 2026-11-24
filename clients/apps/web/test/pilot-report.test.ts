import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { z } from 'zod'
import { pilotEventSchema, type PilotEvent, type PilotReportParameters } from '../lib/pilot/schema'
import { parsePilotLedger, reportPilotLedger } from '../lib/pilot/report'

let sequence = 0
const time = (day: number): string => `2026-10-${String(day).padStart(2, '0')}T12:00:00Z`
const audiences = [
  { audienceId: 'sales', materialIds: ['facts', 'talking-points'] },
  { audienceId: 'cs', materialIds: ['facts', 'faq'] },
]
const manifestHash = 'a'.repeat(64)
const parameters: PilotReportParameters = {
  metricVersion: '1',
  cohortMonth: '2026-10',
  asOf: '2026-12-01T00:00:00Z',
  followupDays: 30,
}

function event<K extends PilotEvent['kind']>(
  kind: K,
  payload: Extract<PilotEvent, { kind: K }>['payload'],
  overrides: Partial<Omit<PilotEvent, 'kind' | 'payload'>> = {}
): Extract<PilotEvent, { kind: K }> {
  sequence += 1
  return pilotEventSchema.parse({
    schemaVersion: 1,
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    organizationId: 'org',
    releaseId: 'release',
    occurredAt: time(10),
    recordedAt: time(10),
    actorId: 'operator',
    provenance: 'CUSTOMER_CONFIRMED',
    sourceRef: 'private-evidence',
    supersedesEventId: null,
    correctionReason: null,
    kind,
    payload,
    ...overrides,
  }) as Extract<PilotEvent, { kind: K }>
}

function base(releaseId = 'release'): PilotEvent[] {
  return [
    event(
      'PARTICIPATION',
      {
        agreementId: 'agreement',
        category: 'PAID_PILOT',
        effectiveFrom: time(1),
        effectiveUntil: null,
      },
      { releaseId: null, occurredAt: time(1), recordedAt: time(1) }
    ),
    event(
      'RELEASE_REGISTERED',
      {
        canonicalReleaseId: releaseId,
        ownerId: 'owner',
        buyerId: 'buyer',
        factReviewerId: 'reviewer',
        intakeAt: time(2),
        readyAt: time(11),
        authorityRef: 'authorized-export',
      },
      { releaseId }
    ),
    event('QUALIFIED', { eligible: true, decisionRef: 'decision', audiences }, { releaseId }),
  ]
}

function chain(audienceId: string, releaseId = 'release', kitRevisionId = 'v1'): PilotEvent[] {
  return [
    event(
      'KIT_APPROVED',
      {
        kitRevisionId,
        manifestHash,
        reviewerId: 'reviewer',
        mode: 'ASSISTED_MANUAL',
        checklistRef: 'checklist',
        audiences,
      },
      { releaseId }
    ),
    event(
      'HANDOFF_RECORDED',
      {
        kitRevisionId,
        manifestHash,
        audienceId,
        destinationId: 'destination',
        status: 'CONFIRMED',
        receiptRef: 'receipt',
      },
      { releaseId, occurredAt: time(11), recordedAt: time(11) }
    ),
    event(
      'USE_CONFIRMED',
      {
        kitRevisionId,
        audienceId,
        evidenceKind: 'NAMED_OWNER_CONFIRMATION',
        confirmingActorOrPublication: 'named-owner',
        status: 'VERIFIED',
        verifiedBy: 'verifier',
        verifiedAt: time(12),
      },
      { releaseId, occurredAt: time(12), recordedAt: time(12) }
    ),
  ]
}

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
const report = (events: unknown[], changes: Partial<PilotReportParameters> = {}) =>
  reportPilotLedger(jsonl(events), { ...parameters, ...changes })

test('published JSON Schema and parser reject the same incomplete record contracts', () => {
  const handoff = chain('sales').find((e) => e.kind === 'HANDOFF_RECORDED')!
  assert.equal(handoff.kind, 'HANDOFF_RECORDED')
  const use = chain('sales').find((e) => e.kind === 'USE_CONFIRMED')!
  assert.equal(use.kind, 'USE_CONFIRMED')
  const qualification = base()[2]
  const baseline = event('EFFORT_RECORDED', {
    task: 'draft',
    role: 'CUSTOMER',
    phase: 'BASELINE',
    minutes: 20,
    basis: 'MEASURED',
    comparableReleaseId: 'prior',
  })
  const invalid = [
    { ...handoff, sourceRef: null, payload: { ...handoff.payload, receiptRef: null } },
    { ...use, sourceRef: null },
    { ...use, payload: { ...use.payload, verifiedBy: null } },
    { ...use, payload: { ...use.payload, verifiedAt: null } },
    { ...qualification, releaseId: null },
    { ...base()[0], releaseId: 'release' },
    { ...qualification, supersedesEventId: handoff.eventId, correctionReason: null },
    { ...qualification, correctionReason: 'Missing target' },
    { ...qualification, provenance: 'ESTIMATED' },
    { ...baseline, payload: { ...baseline.payload, comparableReleaseId: null } },
  ]
  const published = z.fromJSONSchema(z.toJSONSchema(pilotEventSchema))
  for (const record of invalid) {
    assert.equal(pilotEventSchema.safeParse(record).success, false)
    assert.equal(published.safeParse(record).success, false)
    assert.throws(() => parsePilotLedger(jsonl([record])), /Invalid record/)
  }
  for (const record of [...base(), ...chain('sales'), baseline])
    assert.equal(published.safeParse(record).success, true)
})

test('two audiences need exact approved revision, material, handoff and use evidence', () => {
  const records = [...base(), ...chain('sales')]
  const partial = report(records)
  assert.equal(partial.summary.audienceCoverage, 0.5)
  assert.equal(partial.summary.adoptedReleases, 0)
  const complete = report([...records, ...chain('cs', 'release', 'v2')])
  assert.equal(complete.summary.adoptedReleases, 1)
  assert.equal(complete.summary.eligibleReleases, 1)
  assert.equal(complete.rows[0].releaseToApprovalHours, -24)
  assert.equal(complete.summary.preReleaseApproval.samples, 1)
  assert.equal(complete.summary.releaseToApproval.samples, 0)
  for (const broken of [
    chain('cs', 'release', 'v2').map((e) =>
      e.kind === 'HANDOFF_RECORDED' ? { ...e, payload: { ...e.payload, kitRevisionId: 'v0' } } : e
    ),
    chain('cs', 'release', 'v2').map((e) =>
      e.kind === 'HANDOFF_RECORDED'
        ? { ...e, payload: { ...e.payload, manifestHash: 'b'.repeat(64) } }
        : e
    ),
    chain('cs', 'release', 'v2').map((e) =>
      e.kind === 'KIT_APPROVED'
        ? {
            ...e,
            payload: { ...e.payload, audiences: [{ audienceId: 'cs', materialIds: ['facts'] }] },
          }
        : e
    ),
    chain('cs', 'release', 'v2').map((e) =>
      e.kind === 'USE_CONFIRMED'
        ? { ...e, occurredAt: time(10), payload: { ...e.payload, verifiedAt: time(10) } }
        : e
    ),
  ])
    assert.equal(report([...records, ...broken]).summary.adoptedReleases, 0)
})

test('retries and aliases count one release while zero outcomes remain in the denominator', () => {
  const complete = [...base(), ...chain('sales'), ...chain('cs')]
  const approval = chain('sales')[0]
  const alias = event(
    'RELEASE_REGISTERED',
    {
      canonicalReleaseId: 'release',
      ownerId: 'owner',
      buyerId: 'buyer',
      factReviewerId: 'reviewer',
      intakeAt: time(2),
      readyAt: null,
      authorityRef: 'authorized-export',
    },
    { releaseId: 'alias' }
  )
  const result = report([
    ...complete,
    approval,
    approval,
    approval,
    alias,
    ...chain('sales', 'alias'),
  ])
  assert.equal(result.summary.adoptedReleases, 1)
  assert.equal(result.summary.eligibleReleases, 1)
  const zero = report([...base(), ...base('second')])
  assert.equal(zero.summary.activeOrganizations, 1)
  assert.equal(zero.summary.eligibleReleases, 2)
  assert.equal(zero.summary.adoptedReleases, 0)
  assert.equal(zero.summary.eligibleReleaseCoverage, 0)
  assert.equal(report([]).summary.eligibleReleaseCoverage, null)
})

test('month-end cohort, late recording, cutoff and censoring remain distinct', () => {
  const last = '2026-10-31T23:59:59Z'
  const next = '2026-11-01T00:00:00Z'
  const records = base().map((e) =>
    e.kind === 'QUALIFIED' ? { ...e, occurredAt: last, recordedAt: last } : e
  )
  const evidence = [...chain('sales'), ...chain('cs')].map((e) => ({
    ...e,
    occurredAt: next,
    recordedAt: '2026-11-05T00:00:00Z',
    ...(e.kind === 'USE_CONFIRMED' ? { payload: { ...e.payload, verifiedAt: next } } : {}),
  }))
  const early = report([...records, ...evidence], { asOf: '2026-11-02T00:00:00Z' })
  assert.equal(early.summary.adoptedReleases, 0)
  assert.equal(early.censoredReleases, 1)
  assert.equal(early.matured.eligibleReleases, 0)
  const late = report([...records, ...evidence])
  assert.equal(late.summary.adoptedReleases, 1)
  assert.equal(late.rows[0].cohortMonth, '2026-10')
  assert.equal(
    report([...records, ...evidence], { cohortMonth: '2026-11' }).summary.eligibleReleases,
    0
  )
})

test('corrections restate outcomes without changing first qualification or deleting withdrawal', () => {
  const records = [...base(), ...chain('sales'), ...chain('cs')]
  const use = records.find((e) => e.kind === 'USE_CONFIRMED')!
  assert.equal(use.kind, 'USE_CONFIRMED')
  const corrected = event(
    'USE_CONFIRMED',
    { ...use.payload, status: 'RETRACTED' },
    {
      supersedesEventId: use.eventId,
      correctionReason: 'Confirmation withdrawn',
      recordedAt: time(20),
      occurredAt: time(12),
    }
  )
  const qualification = records.find((e) => e.kind === 'QUALIFIED')!
  assert.equal(qualification.kind, 'QUALIFIED')
  const ineligible = event(
    'QUALIFIED',
    { ...qualification.payload, eligible: false },
    {
      supersedesEventId: qualification.eventId,
      correctionReason: 'Eligibility corrected',
      recordedAt: time(20),
      occurredAt: time(19),
    }
  )
  const withdrawn = event(
    'WITHDRAWN',
    { reason: 'Owner stopped this release' },
    { occurredAt: time(20), recordedAt: time(20) }
  )
  assert.equal(report([...records, corrected], { asOf: time(15) }).summary.adoptedReleases, 1)
  const result = report([...records, corrected, ineligible, withdrawn])
  assert.equal(result.summary.adoptedReleases, 0)
  assert.equal(result.summary.eligibleReleases, 1)
  assert.equal(result.rows[0].qualifiedAt, time(10))
  assert.equal(result.rows[0].qualificationRestated, true)
  assert.equal(result.rows[0].withdrawn, true)
  assert.equal(result.rows[0].pendingOrRetractedUses, 1)
})

test('audience requirements cannot shrink after delivery or by backdated recording', () => {
  const records = [...base(), ...chain('sales')]
  for (const occurredAt of [time(9), time(15)]) {
    const amendment = event(
      'REQUIREMENTS_REVISED',
      { reason: 'CS no longer requested', audiences: [audiences[0]] },
      { occurredAt, recordedAt: time(15) }
    )
    const result = report([...records, amendment])
    assert.equal(result.summary.requiredAudiences, 2)
    assert.equal(result.summary.adoptedReleases, 0)
    assert.equal(result.rows[0].prospectiveRequirementChanges, 1)
  }
  const before = event(
    'REQUIREMENTS_REVISED',
    { reason: 'CS omitted before delivery', audiences: [audiences[0]] },
    { occurredAt: time(10), recordedAt: time(10) }
  )
  assert.equal(report([...records, before]).summary.adoptedReleases, 1)
})

test('erased source evidence downgrades verification without shrinking the cohort', () => {
  const result = report([
    ...base(),
    ...chain('sales'),
    ...chain('cs'),
    event(
      'EVIDENCE_REMOVED',
      { removedSourceRef: 'private-evidence', reason: 'Retention request' },
      { releaseId: null, sourceRef: null, occurredAt: time(20), recordedAt: time(20) }
    ),
  ])
  assert.equal(result.summary.adoptedReleases, 0)
  assert.equal(result.summary.eligibleReleases, 1)
  assert.ok(result.rows[0].evidenceUnavailable > 0)
  assert.equal(result.rows[0].recordedDelivery, true)
})

test('correcting a handoff cannot move the frozen audience boundary past a later reduction', () => {
  const original = chain('sales')
  const handoff = original.find((e) => e.kind === 'HANDOFF_RECORDED')!
  assert.equal(handoff.kind, 'HANDOFF_RECORDED')
  const corrected = event(
    'HANDOFF_RECORDED',
    { ...handoff.payload, status: 'FAILED' },
    {
      supersedesEventId: handoff.eventId,
      correctionReason: 'Receipt corrected',
      occurredAt: time(11),
      recordedAt: time(20),
    }
  )
  const reduced = event(
    'REQUIREMENTS_REVISED',
    { reason: 'CS removed after original delivery', audiences: [audiences[0]] },
    { occurredAt: time(15), recordedAt: time(15) }
  )
  const later = chain('sales', 'release', 'later').map((e) =>
    e.kind === 'USE_CONFIRMED'
      ? {
          ...e,
          occurredAt: time(17),
          recordedAt: time(17),
          payload: { ...e.payload, verifiedAt: time(17) },
        }
      : { ...e, occurredAt: time(16), recordedAt: time(16) }
  )
  const result = report([...base(), ...original, corrected, reduced, ...later])
  assert.equal(result.summary.requiredAudiences, 2)
  assert.equal(result.summary.adoptedReleases, 0)
})

test('post-delivery corrections preserve the requirement amendment in force at delivery', () => {
  const records = base().map((e) =>
    e.kind === 'QUALIFIED' ? { ...e, payload: { ...e.payload, audiences: [audiences[0]] } } : e
  )
  const amendment = event('REQUIREMENTS_REVISED', { reason: 'CS also requires the kit', audiences })
  for (const replacementAudiences of [audiences, [audiences[0]]]) {
    const corrected = event(
      'REQUIREMENTS_REVISED',
      { reason: 'Clarified wording or prospective change', audiences: replacementAudiences },
      {
        supersedesEventId: amendment.eventId,
        correctionReason: 'Append correction',
        occurredAt: time(10),
        recordedAt: time(20),
      }
    )
    const result = report([...records, amendment, ...chain('sales'), corrected])
    assert.equal(result.summary.requiredAudiences, 2)
    assert.equal(result.summary.adoptedReleases, 0)
    assert.equal(result.rows[0].prospectiveRequirementChanges, 1)
  }
})

test('an eligibility correction enters the original cohort and later corrections cannot remove it', () => {
  const records = base().map((e) =>
    e.kind === 'QUALIFIED' ? { ...e, payload: { ...e.payload, eligible: false } } : e
  )
  const original = records.find((e) => e.kind === 'QUALIFIED')!
  assert.equal(original.kind, 'QUALIFIED')
  const correction = event(
    'QUALIFIED',
    { ...original.payload, eligible: true },
    {
      supersedesEventId: original.eventId,
      correctionReason: 'Mistaken exclusion',
      occurredAt: time(15),
      recordedAt: time(15),
    }
  )
  const result = report([...records, correction, ...chain('sales'), ...chain('cs')])
  assert.equal(result.summary.eligibleReleases, 1)
  assert.equal(result.summary.adoptedReleases, 1)
  assert.equal(result.rows[0].qualifiedAt, time(10))
  const later = event(
    'QUALIFIED',
    { ...original.payload, eligible: false },
    {
      supersedesEventId: correction.eventId,
      correctionReason: 'Later restatement',
      occurredAt: time(20),
      recordedAt: time(20),
    }
  )
  assert.equal(report([...records, correction, later]).summary.eligibleReleases, 1)
  assert.equal(report([...records, correction], { asOf: time(14) }).summary.eligibleReleases, 0)
})

test('participation is effective at qualification, not merely true at report time', () => {
  const records = base().map((e) =>
    e.kind === 'PARTICIPATION' ? { ...e, payload: { ...e.payload, effectiveFrom: time(15) } } : e
  )
  assert.equal(report(records).summary.activeOrganizations, 0)
  assert.equal(
    report(
      base().map((e) =>
        e.kind === 'PARTICIPATION'
          ? { ...e, payload: { ...e.payload, effectiveUntil: time(10) } }
          : e
      )
    ).summary.activeOrganizations,
    0
  )
})

test('effort preserves missing baselines, unknown values, estimates and operator assistance', () => {
  const operator = event('EFFORT_RECORDED', {
    task: 'draft',
    role: 'OPERATOR',
    phase: 'CURRENT',
    minutes: 90,
    basis: 'MEASURED',
    comparableReleaseId: null,
  })
  const onlyOperator = report([...base(), operator]).rows[0].effort
  assert.equal(onlyOperator.customerMinutes, null)
  assert.equal(onlyOperator.operatorMinutes, 90)
  assert.equal(onlyOperator.laborSavedMinutes, null)
  assert.equal(onlyOperator.totalMinutes, null)
  const customer = event('EFFORT_RECORDED', {
    task: 'draft',
    role: 'CUSTOMER',
    phase: 'CURRENT',
    minutes: 20,
    basis: 'MEASURED',
    comparableReleaseId: null,
  })
  const baseline = event('EFFORT_RECORDED', {
    task: 'draft',
    role: 'CUSTOMER',
    phase: 'BASELINE',
    minutes: 100,
    basis: 'ESTIMATED',
    comparableReleaseId: 'prior-release',
  })
  const result = report([...base(), customer, operator, baseline]).rows[0].effort
  assert.equal(result.laborSavedMinutes, 80)
  assert.equal(result.totalMinutes, 110)
  assert.equal(result.estimated, true)
  assert.equal(
    report([...base(), { ...customer, payload: { ...customer.payload, minutes: null } }]).rows[0]
      .effort.customerMinutes,
    null
  )
})

test('money uses integer micros, deduplicated lines, separate currencies and explicit allocation', () => {
  const authorized = event(
    'PAYMENT_RECORDED',
    {
      lineId: 'payment',
      agreementId: 'agreement',
      amountMicros: '300000000',
      currency: 'USD',
      status: 'AUTHORIZED',
    },
    { releaseId: null }
  )
  const failed = event(
    'PAYMENT_RECORDED',
    {
      lineId: 'payment',
      agreementId: 'agreement',
      amountMicros: '300000000',
      currency: 'USD',
      status: 'FAILED',
    },
    { releaseId: null }
  )
  const usd = event('COST_RECORDED', {
    lineId: 'invoice-1',
    category: 'AI',
    quantity: '1',
    amountMicros: '9007199254740993',
    currency: 'USD',
    status: 'SETTLED',
  })
  const euro = event('COST_RECORDED', {
    lineId: 'invoice-2',
    category: 'HUMAN_ASSISTANCE',
    quantity: '1.5',
    amountMicros: '25000000',
    currency: 'EUR',
    status: 'ESTIMATED',
  })
  const result = report([
    ...base(),
    authorized,
    failed,
    usd,
    { ...usd, eventId: event('WITHDRAWN', { reason: 'id only' }).eventId },
    euro,
  ])
  assert.equal(result.economics.unallocated[0].collectedMicros, '0')
  assert.equal(result.economics.unallocated[0].authorizedMicros, '300000000')
  assert.deepEqual(
    result.economics.allocated.map((e) => e.currency),
    ['EUR', 'USD']
  )
  assert.equal(result.economics.allocated[1].settledCostMicros, '9007199254740993')
  assert.equal(result.economics.allocated[1].settledCostPerAdopted, null)
  assert.throws(
    () =>
      report([
        ...base(),
        usd,
        {
          ...usd,
          eventId: event('WITHDRAWN', { reason: 'id' }).eventId,
          payload: { ...usd.payload, amountMicros: '2' },
        },
      ]),
    /Conflicting cost/
  )
})

test('factual corrections count delivered releases once, with claims counted separately', () => {
  const factual = event(
    'FACT_CORRECTION',
    {
      kitRevisionId: 'v1',
      claimIds: ['claim-a', 'claim-b'],
      classification: 'FACTUAL',
      severity: 'MAJOR',
      resolutionRevisionId: 'v2',
    },
    { occurredAt: time(15), recordedAt: time(15) }
  )
  const result = report([
    ...base(),
    ...base('unused'),
    ...chain('sales'),
    ...chain('cs'),
    factual,
    event(
      'FACT_CORRECTION',
      { ...factual.payload, claimIds: ['claim-a'] },
      { occurredAt: time(16), recordedAt: time(16) }
    ),
  ])
  assert.equal(result.summary.deliveredReleases, 1)
  assert.equal(result.summary.factualCorrections, 1)
  assert.equal(result.summary.factualCorrectionRate, 1)
  assert.equal(result.rows.find((r) => r.releaseId === 'release')!.correctedClaimCount, 2)
})

test('repeat use, paid renewal and renewal intent remain separate', () => {
  const later = [
    ...base('later'),
    ...chain('sales', 'later', 'later-v1'),
    ...chain('cs', 'later', 'later-v1'),
  ].map((e) => ({
    ...e,
    occurredAt: time(20),
    recordedAt: time(20),
    ...(e.kind === 'USE_CONFIRMED' ? { payload: { ...e.payload, verifiedAt: time(20) } } : {}),
  }))
  const result = report([
    ...base(),
    ...chain('sales'),
    ...chain('cs'),
    ...later,
    event('RENEWAL_RECORDED', { agreementId: 'agreement', status: 'INTENT' }, { releaseId: null }),
  ])
  assert.equal(result.repeatUseOrganizations, 1)
  assert.deepEqual(result.renewals, [{ organizationId: 'org', paid: false, intent: true }])
})

test('invalid records, corrections, cycles and cross-organization references fail closed', () => {
  const original = base()[2]
  const correction = {
    ...original,
    eventId: event('WITHDRAWN', { reason: 'id' }).eventId,
    supersedesEventId: original.eventId,
    correctionReason: 'fix',
  }
  assert.throws(() => parsePilotLedger('{bad json'), /Invalid JSON at line 1/)
  assert.throws(
    () => parsePilotLedger(JSON.stringify({ ...original, secret: 'do not echo' })),
    (error: Error) => /Invalid record/.test(error.message) && !error.message.includes('do not echo')
  )
  assert.throws(
    () => parsePilotLedger(jsonl([original, { ...original, actorId: 'changed' }])),
    /Changed duplicate/
  )
  assert.throws(
    () =>
      parsePilotLedger(
        jsonl([
          original,
          correction,
          { ...correction, eventId: event('WITHDRAWN', { reason: 'id' }).eventId },
        ])
      ),
    /Two replacements/
  )
  assert.throws(
    () => parsePilotLedger(jsonl([original, { ...correction, organizationId: 'foreign' }])),
    /same organization/
  )
  assert.throws(
    () =>
      parsePilotLedger(
        jsonl([
          { ...original, supersedesEventId: correction.eventId, correctionReason: 'cycle' },
          correction,
        ])
      ),
    /Correction cycle/
  )
  assert.throws(
    () =>
      report([...base(), event('WITHDRAWN', { reason: 'foreign' }, { organizationId: 'other' })]),
    /Unknown or foreign release/
  )
  const alias = event(
    'RELEASE_REGISTERED',
    {
      canonicalReleaseId: 'release',
      ownerId: 'owner',
      buyerId: 'buyer',
      factReviewerId: 'reviewer',
      intakeAt: time(2),
      readyAt: null,
      authorityRef: 'authorized-export',
    },
    { releaseId: 'alias' }
  )
  assert.throws(
    () =>
      report([
        ...base().map((e) =>
          e.kind === 'RELEASE_REGISTERED'
            ? { ...e, payload: { ...e.payload, canonicalReleaseId: 'alias' } }
            : e
        ),
        alias,
      ]),
    /Canonical release cycle/
  )
})

test('report is reproducible by hash and explicit parameters; schema and blank template are usable', () => {
  const folder = mkdtempSync(join(tmpdir(), 'shots-pilot-synthetic-'))
  try {
    const input = jsonl([...base(), ...chain('sales'), ...chain('cs')])
    const path = join(folder, 'ledger.jsonl')
    writeFileSync(path, input, { mode: 0o600 })
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'scripts/pilot-report.ts', ...args], {
        cwd: process.cwd(),
        encoding: 'utf8',
      })
    const args = [
      '--input',
      path,
      '--metric-version',
      '1',
      '--cohort-month',
      '2026-10',
      '--as-of',
      parameters.asOf,
      '--followup-days',
      '30',
    ]
    const first = run(args)
    assert.equal(first.status, 0, first.stderr)
    assert.equal(run(args).stdout, first.stdout)
    const result = JSON.parse(first.stdout) as ReturnType<typeof reportPilotLedger>
    assert.equal(result.summary.adoptedReleases, 1)
    assert.equal(
      result.manifest.inputSha256,
      createHash('sha256').update(readFileSync(path)).digest('hex')
    )
    assert.equal(result.manifest.metricVersion, '1')
    assert.equal(run(args.slice(0, -2)).status, 1)
    assert.equal(run(['--template']).stdout, '')
    assert.equal(JSON.parse(run(['--schema']).stdout).$id, 'urn:shots:pilot-event:1')
    const malformed = Buffer.from(input)
    malformed[malformed.indexOf('private-evidence')] = 0xff
    writeFileSync(path, malformed)
    const rejected = run(args)
    assert.equal(rejected.status, 1, 'invalid UTF-8 must not be silently replaced before hashing')
    assert.equal(rejected.stdout, '')
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
