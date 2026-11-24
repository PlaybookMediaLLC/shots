import { createHash } from 'node:crypto'
import {
  pilotEventSchema,
  pilotReportParametersSchema,
  type PilotEvent,
  type PilotReportParameters,
} from './schema'

type EventOf<K extends PilotEvent['kind']> = Extract<PilotEvent, { kind: K }>
const ofKind = <K extends PilotEvent['kind']>(events: PilotEvent[], kind: K): EventOf<K>[] =>
  events.filter((event): event is EventOf<K> => event.kind === kind)
const instant = (value: string): number => Date.parse(value)
const key = (org: string, id: string): string => JSON.stringify([org, id])
const at = (event: PilotEvent): number => instant(event.occurredAt)
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const ordered = (a: PilotEvent, b: PilotEvent): number =>
  at(a) - at(b) || compare(a.eventId, b.eventId)

/** Validate a complete private export. Errors identify rows, never private payload values. */
export function parsePilotLedger(input: string): PilotEvent[] {
  const byId = new Map<string, PilotEvent>()
  input.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`Invalid JSON at line ${index + 1}`)
    }
    const parsed = pilotEventSchema.safeParse(value)
    if (!parsed.success)
      throw new Error(`Invalid record at line ${index + 1}; check the pilot-event v1 schema`)
    const event = parsed.data
    const previous = byId.get(event.eventId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(event))
      throw new Error(`Changed duplicate event at line ${index + 1}`)
    if (at(event) > instant(event.recordedAt))
      throw new Error(`Observation follows recording at line ${index + 1}`)
    if ('audiences' in event.payload) {
      const audiences = event.payload.audiences
      if (
        new Set(audiences.map((a) => a.audienceId)).size !== audiences.length ||
        audiences.some((a) => new Set(a.materialIds).size !== a.materialIds.length)
      )
        throw new Error(`Duplicate requirement at line ${index + 1}`)
    }
    if (
      event.kind === 'PARTICIPATION' &&
      event.payload.effectiveUntil &&
      instant(event.payload.effectiveUntil) <= instant(event.payload.effectiveFrom)
    )
      throw new Error(`Invalid participation interval at line ${index + 1}`)
    if (
      event.kind === 'USE_CONFIRMED' &&
      event.payload.status === 'VERIFIED' &&
      (instant(event.payload.verifiedAt) < at(event) ||
        instant(event.payload.verifiedAt) > instant(event.recordedAt))
    )
      throw new Error(`Missing or invalid use verification at line ${index + 1}`)
    byId.set(event.eventId, event)
  })
  const replacements = new Map<string, string>()
  for (const event of byId.values()) {
    if (!event.supersedesEventId) continue
    const target = byId.get(event.supersedesEventId)
    if (
      !target ||
      target.organizationId !== event.organizationId ||
      target.releaseId !== event.releaseId ||
      target.kind !== event.kind
    )
      throw new Error('Correction target must have the same organization, release and kind')
    if (replacements.has(target.eventId)) throw new Error('Two replacements of the same event')
    if (instant(event.recordedAt) < instant(target.recordedAt))
      throw new Error('Correction recorded before its target')
    replacements.set(target.eventId, event.eventId)
  }
  const checked = new Set<string>()
  for (const event of byId.values()) {
    const seen = new Set<string>()
    let cursor: PilotEvent | undefined = event
    while (cursor && !checked.has(cursor.eventId)) {
      if (seen.has(cursor.eventId)) throw new Error('Correction cycle')
      seen.add(cursor.eventId)
      cursor = cursor.supersedesEventId ? byId.get(cursor.supersedesEventId) : undefined
    }
    for (const id of seen) checked.add(id)
  }
  return [...byId.values()].sort(ordered)
}

function durations(values: (number | null)[]) {
  const observed = values.filter((value): value is number => value !== null).sort((a, b) => a - b)
  const middle = Math.floor(observed.length / 2)
  return {
    samples: observed.length,
    missing: values.length - observed.length,
    medianHours: observed.length
      ? observed.length % 2
        ? observed[middle]
        : (observed[middle - 1] + observed[middle]) / 2
      : null,
    p90Hours: observed.length ? observed[Math.ceil(observed.length * 0.9) - 1] : null,
  }
}

function effort(events: PilotEvent[]) {
  const entries = ofKind(events, 'EFFORT_RECORDED')
  const current = entries.filter((e) => e.payload.phase === 'CURRENT')
  const sum = (items: typeof entries): number | null =>
    items.length && items.every((e) => e.payload.minutes !== null)
      ? items.reduce((total, e) => total + (e.payload.minutes ?? 0), 0)
      : null
  const customers = current.filter((e) => e.payload.role === 'CUSTOMER')
  const baseline = entries.filter(
    (e) => e.payload.phase === 'BASELINE' && e.payload.role === 'CUSTOMER'
  )
  const tasks = [...new Set(customers.map((e) => e.payload.task))].sort()
  const comparable =
    tasks.length > 0 &&
    tasks.every((task) => {
      const matches = baseline.filter((e) => e.payload.task === task)
      return (
        matches.length > 0 && new Set(matches.map((e) => e.payload.comparableReleaseId)).size === 1
      )
    })
  const customerMinutes = sum(customers)
  const operatorMinutes = sum(current.filter((e) => e.payload.role === 'OPERATOR'))
  const baselineMinutes = comparable
    ? sum(baseline.filter((e) => tasks.includes(e.payload.task)))
    : null
  return {
    scope: 'RECORDED_TASKS_ONLY',
    tasks,
    customerMinutes,
    operatorMinutes,
    totalMinutes:
      customerMinutes !== null && operatorMinutes !== null
        ? customerMinutes + operatorMinutes
        : null,
    baselineMinutes,
    laborSavedMinutes:
      customerMinutes !== null && baselineMinutes !== null
        ? baselineMinutes - customerMinutes
        : null,
    estimated: entries.some((e) => e.payload.basis === 'ESTIMATED'),
  }
}

function money(events: PilotEvent[], delivered: number, adopted: number) {
  const currencies = new Map<
    string,
    {
      settledCost: bigint
      estimatedCost: bigint
      collected: bigint
      refunded: bigint
      authorized: bigint
      committed: bigint
    }
  >()
  const lines = new Map<string, PilotEvent>()
  for (const event of events) {
    if (event.kind !== 'COST_RECORDED' && event.kind !== 'PAYMENT_RECORDED') continue
    const identity = key(
      event.organizationId,
      `${event.kind}:${event.payload.lineId}:${event.payload.status}`
    )
    const prior = lines.get(identity)
    if (prior) {
      if (
        prior.releaseId !== event.releaseId ||
        JSON.stringify(prior.payload) !== JSON.stringify(event.payload)
      )
        throw new Error('Conflicting cost or payment line')
      continue
    }
    lines.set(identity, event)
    const totals = currencies.get(event.payload.currency) ?? {
      settledCost: BigInt(0),
      estimatedCost: BigInt(0),
      collected: BigInt(0),
      refunded: BigInt(0),
      authorized: BigInt(0),
      committed: BigInt(0),
    }
    const amount = BigInt(event.payload.amountMicros)
    if (event.kind === 'COST_RECORDED')
      totals[event.payload.status === 'SETTLED' ? 'settledCost' : 'estimatedCost'] += amount
    else if (event.payload.status === 'COLLECTED') totals.collected += amount
    else if (event.payload.status === 'REFUNDED') totals.refunded += amount
    else if (event.payload.status === 'AUTHORIZED') totals.authorized += amount
    else if (event.payload.status === 'COMMITTED') totals.committed += amount
    currencies.set(event.payload.currency, totals)
  }
  return [...currencies.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([currency, totals]) => ({
      currency,
      settledCostMicros: totals.settledCost.toString(),
      estimatedCostMicros: totals.estimatedCost.toString(),
      collectedMicros: totals.collected.toString(),
      refundedMicros: totals.refunded.toString(),
      authorizedMicros: totals.authorized.toString(),
      committedMicros: totals.committed.toString(),
      netCollectedMicros: (totals.collected - totals.refunded).toString(),
      settledCostPerDelivered: delivered
        ? { totalMicros: totals.settledCost.toString(), kits: delivered }
        : null,
      settledCostPerAdopted: adopted
        ? { totalMicros: totals.settledCost.toString(), kits: adopted }
        : null,
    }))
}

/** Pure, deterministic analysis of asserted evidence; no database access or analytics side effects. */
export function reportPilotLedger(input: string, rawParameters: PilotReportParameters) {
  const parameters = pilotReportParametersSchema.parse(rawParameters)
  const all = parsePilotLedger(input)
  const asOf = instant(parameters.asOf)
  const known = all.filter((e) => instant(e.recordedAt) <= asOf)
  const superseded = new Set(
    known.flatMap((e) => (e.supersedesEventId ? [e.supersedesEventId] : []))
  )
  const effective = known.filter((e) => !superseded.has(e.eventId))
  const registrations = ofKind(effective, 'RELEASE_REGISTERED')
  const registry = new Map<string, EventOf<'RELEASE_REGISTERED'>>()
  for (const registration of registrations) {
    const identity = key(registration.organizationId, registration.releaseId!)
    if (registry.has(identity)) throw new Error('Release has multiple active registrations')
    registry.set(identity, registration)
  }
  const canonicalIds = new Map<string, string>()
  const canonical = (org: string, releaseId: string): string => {
    const cached = canonicalIds.get(key(org, releaseId))
    if (cached) return cached
    const seen = new Set<string>()
    let cursor = releaseId
    for (;;) {
      if (seen.has(cursor)) throw new Error('Canonical release cycle')
      seen.add(cursor)
      const registration = registry.get(key(org, cursor))
      if (!registration) throw new Error('Unknown or foreign release reference')
      if (registration.payload.canonicalReleaseId === cursor) {
        const identity = key(org, cursor)
        for (const id of seen) canonicalIds.set(key(org, id), identity)
        return identity
      }
      cursor = registration.payload.canonicalReleaseId
    }
  }
  const releaseEvents = new Map<string, PilotEvent[]>()
  for (const event of effective) {
    if (!event.releaseId) continue
    const identity = canonical(event.organizationId, event.releaseId)
    const group = releaseEvents.get(identity) ?? []
    group.push(event)
    releaseEvents.set(identity, group)
  }
  const removed = new Set(
    ofKind(effective, 'EVIDENCE_REMOVED').map((e) =>
      key(e.organizationId, e.payload.removedSourceRef)
    )
  )
  const available = (event: PilotEvent): boolean =>
    !!event.sourceRef && !removed.has(key(event.organizationId, event.sourceRef))
  const participants = ofKind(effective, 'PARTICIPATION')
  const firstDeliveries = new Map<string, EventOf<'HANDOFF_RECORDED'>>()
  for (const event of ofKind(known, 'HANDOFF_RECORDED')) {
    if (event.payload.status !== 'CONFIRMED') continue
    const identity = canonical(event.organizationId, event.releaseId!)
    if (!firstDeliveries.has(identity)) firstDeliveries.set(identity, event)
  }
  const firstQualifications = new Map<string, EventOf<'QUALIFIED'>>()
  const qualifications = new Map(ofKind(known, 'QUALIFIED').map((e) => [e.eventId, e]))
  for (const event of ofKind(known, 'QUALIFIED')) {
    if (!event.payload.eligible) continue
    const identity = canonical(event.organizationId, event.releaseId!)
    let original = event
    while (original.supersedesEventId) original = qualifications.get(original.supersedesEventId)!
    const first = firstQualifications.get(identity)
    if (!first || ordered(original, first) < 0) firstQualifications.set(identity, original)
  }
  const rows = [...firstQualifications.entries()]
    .sort(([a], [b]) => compare(a, b))
    .flatMap(([identity, first]) => {
      if (
        !participants.some(
          (p) =>
            p.organizationId === first.organizationId &&
            instant(p.payload.effectiveFrom) <= at(first) &&
            (!p.payload.effectiveUntil || instant(p.payload.effectiveUntil) > at(first))
        )
      )
        return []
      const registered = registry.get(identity)!
      const cutoff = Math.min(asOf, at(first) + parameters.followupDays * 86_400_000)
      const events = (releaseEvents.get(identity) ?? []).filter((e) => at(e) <= cutoff)
      const handoffs = ofKind(events, 'HANDOFF_RECORDED')
      // A correction cannot silently move the original denominator-freeze boundary.
      const firstDelivery = firstDeliveries.get(identity)
      const amendments = ofKind(known, 'REQUIREMENTS_REVISED').filter(
        (e) => canonical(e.organizationId, e.releaseId!) === identity && at(e) <= cutoff
      )
      const historical = amendments.filter(
        (e) =>
          !firstDelivery ||
          (at(e) < at(firstDelivery) && instant(e.recordedAt) <= instant(firstDelivery.recordedAt))
      )
      const replacedRequirements = new Set(
        historical.flatMap((e) => (e.supersedesEventId ? [e.supersedesEventId] : []))
      )
      const applied = historical
        .filter((e) => !replacedRequirements.has(e.eventId))
        .sort(ordered)
        .at(-1)
      const requirements = applied?.payload.audiences ?? first.payload.audiences
      const approvals = ofKind(events, 'KIT_APPROVED')
      const uses = ofKind(events, 'USE_CONFIRMED')
      const audiences = requirements.map((requirement) => {
        const deliveries = handoffs.filter(
          (handoff) =>
            handoff.payload.audienceId === requirement.audienceId &&
            handoff.payload.status === 'CONFIRMED' &&
            available(handoff) &&
            approvals.some(
              (approval) =>
                available(approval) &&
                approval.payload.kitRevisionId === handoff.payload.kitRevisionId &&
                approval.payload.manifestHash === handoff.payload.manifestHash &&
                at(approval) <= at(handoff) &&
                approval.payload.audiences.some(
                  (audience) =>
                    audience.audienceId === requirement.audienceId &&
                    requirement.materialIds.every((material) =>
                      audience.materialIds.includes(material)
                    )
                )
            )
        )
        const use = uses.find(
          (candidate) =>
            candidate.payload.audienceId === requirement.audienceId &&
            candidate.payload.status === 'VERIFIED' &&
            available(candidate) &&
            instant(candidate.payload.verifiedAt!) <= cutoff &&
            deliveries.some(
              (delivery) =>
                delivery.payload.kitRevisionId === candidate.payload.kitRevisionId &&
                at(delivery) <= at(candidate)
            )
        )
        return {
          audienceId: requirement.audienceId,
          delivered: deliveries.length > 0,
          used: !!use,
          useEventId: use?.eventId ?? null,
          kitRevisionId: use?.payload.kitRevisionId ?? null,
        }
      })
      const firstApproval = approvals.filter(available).sort(ordered)[0]
      const deliveredRevisions = new Set(
        handoffs.filter((e) => e.payload.status === 'CONFIRMED').map((e) => e.payload.kitRevisionId)
      )
      const corrections = ofKind(events, 'FACT_CORRECTION').filter(
        (e) =>
          e.payload.classification === 'FACTUAL' &&
          handoffs.some(
            (handoff) =>
              handoff.payload.status === 'CONFIRMED' &&
              handoff.payload.kitRevisionId === e.payload.kitRevisionId &&
              at(handoff) <= at(e)
          )
      )
      return [
        {
          organizationId: first.organizationId,
          releaseId: registered.releaseId!,
          cohortMonth: first.occurredAt.slice(0, 7),
          qualifiedAt: first.occurredAt,
          cutoff: new Date(cutoff).toISOString(),
          censored: asOf < at(first) + parameters.followupDays * 86_400_000,
          withdrawn: ofKind(events, 'WITHDRAWN').length > 0,
          qualificationRestated: ofKind(events, 'QUALIFIED').some(
            (e) => e.supersedesEventId !== null
          ),
          prospectiveRequirementChanges: amendments.filter(
            (e) =>
              firstDelivery &&
              (at(e) >= at(firstDelivery) ||
                instant(e.recordedAt) > instant(firstDelivery.recordedAt))
          ).length,
          audiences,
          adopted: audiences.every((a) => a.used),
          delivered: audiences.every((a) => a.delivered),
          recordedDelivery: deliveredRevisions.size > 0,
          evidenceUnavailable: events.filter(
            (e) => e.sourceRef && removed.has(key(e.organizationId, e.sourceRef))
          ).length,
          pendingOrRetractedUses: uses.filter((e) => e.payload.status !== 'VERIFIED').length,
          approvalModes: [...new Set(approvals.map((e) => e.payload.mode))].sort(),
          releaseToApprovalHours:
            firstApproval && registered.payload.readyAt
              ? (at(firstApproval) - instant(registered.payload.readyAt)) / 3_600_000
              : null,
          intakeToApprovalHours: firstApproval
            ? (at(firstApproval) - instant(registered.payload.intakeAt)) / 3_600_000
            : null,
          factualCorrection: corrections.length > 0,
          correctedClaimCount: new Set(corrections.flatMap((e) => e.payload.claimIds)).size,
          effort: effort(events),
          economics: money(
            events,
            deliveredRevisions.size > 0 ? 1 : 0,
            audiences.every((a) => a.used) ? 1 : 0
          ),
        },
      ]
    })
  const cohort = rows.filter((r) => r.cohortMonth === parameters.cohortMonth)
  const summarize = (selected: typeof rows) => {
    const activeOrganizations = new Set(selected.map((r) => r.organizationId)).size
    const adopted = selected.filter((r) => r.adopted).length
    const delivered = selected.filter((r) => r.recordedDelivery).length
    const audiences = selected.flatMap((r) => r.audiences)
    const ordinary = selected
      .map((r) => r.releaseToApprovalHours)
      .filter((v) => v === null || v >= 0)
    return {
      activeOrganizations,
      eligibleReleases: selected.length,
      adoptedReleases: adopted,
      adoptedPerOrganization: activeOrganizations ? adopted / activeOrganizations : null,
      eligibleReleaseCoverage: selected.length ? adopted / selected.length : null,
      requiredAudiences: audiences.length,
      audiencesUsed: audiences.filter((a) => a.used).length,
      audienceCoverage: audiences.length
        ? audiences.filter((a) => a.used).length / audiences.length
        : null,
      deliveredReleases: delivered,
      factualCorrections: selected.filter((r) => r.factualCorrection).length,
      factualCorrectionRate: delivered
        ? selected.filter((r) => r.factualCorrection).length / delivered
        : null,
      releaseToApproval: durations(ordinary),
      preReleaseApproval: durations(
        selected.flatMap((r) =>
          r.releaseToApprovalHours !== null && r.releaseToApprovalHours < 0
            ? [r.releaseToApprovalHours]
            : []
        )
      ),
      intakeToApproval: durations(selected.map((r) => r.intakeToApprovalHours)),
    }
  }
  const orgs = new Set(cohort.map((r) => r.organizationId))
  const cohortKeys = new Map(
    cohort.map((r) => [key(r.organizationId, r.releaseId), instant(r.cutoff)])
  )
  const allocated = effective.filter(
    (e) =>
      e.releaseId &&
      at(e) <= (cohortKeys.get(canonical(e.organizationId, e.releaseId)) ?? -Infinity)
  )
  const unallocated = effective.filter(
    (e) =>
      !e.releaseId &&
      orgs.has(e.organizationId) &&
      e.occurredAt.slice(0, 7) === parameters.cohortMonth
  )
  const summary = summarize(cohort)
  return {
    manifest: {
      ...parameters,
      schemaVersion: 1,
      inputSha256: createHash('sha256').update(input).digest('hex'),
      inputRecords: all.length,
      knownRecords: known.length,
      authority: 'PRIVATE_LEDGER_ASSERTIONS_NOT_NATIVE_VERIFICATION',
    },
    rows: cohort,
    summary,
    matured: summarize(cohort.filter((r) => !r.censored)),
    censoredReleases: cohort.filter((r) => r.censored).length,
    repeatUseOrganizations: [...orgs].filter((org) =>
      cohort.some(
        (r) =>
          r.organizationId === org &&
          r.adopted &&
          rows.some(
            (later) =>
              later.organizationId === org &&
              later.adopted &&
              instant(later.qualifiedAt) > instant(r.qualifiedAt)
          )
      )
    ).length,
    renewals: [...orgs].sort().map((organizationId) => ({
      organizationId,
      paid: ofKind(effective, 'RENEWAL_RECORDED').some(
        (e) => e.organizationId === organizationId && e.payload.status === 'PAID'
      ),
      intent: ofKind(effective, 'RENEWAL_RECORDED').some(
        (e) => e.organizationId === organizationId && e.payload.status === 'INTENT'
      ),
    })),
    economics: {
      allocation: 'EXPLICIT_RELEASE_LINK_ONLY',
      allocated: money(allocated, summary.deliveredReleases, summary.adoptedReleases),
      unallocated: money(unallocated, 0, 0),
    },
  }
}
