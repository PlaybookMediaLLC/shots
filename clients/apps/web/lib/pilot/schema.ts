import { z } from 'zod'

const id = z.string().min(1).max(200)
const time = z.iso.datetime()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const currency = z.string().regex(/^[A-Z]{3}$/)
const micros = z.string().regex(/^(0|[1-9][0-9]{0,29})$/)
const audience = z.strictObject({ audienceId: id, materialIds: z.array(id).min(1) })
const envelope = {
  schemaVersion: z.literal(1),
  eventId: z.uuid(),
  organizationId: id,
  releaseId: id,
  occurredAt: time,
  recordedAt: time,
  actorId: id,
  provenance: z.enum(['CUSTOMER_CONFIRMED', 'OPERATOR_OBSERVED', 'ESTIMATED']),
  sourceRef: id.nullable(),
}

function record<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.union([
    z.strictObject({
      ...envelope,
      ...shape,
      supersedesEventId: z.null(),
      correctionReason: z.null(),
    }),
    z.strictObject({
      ...envelope,
      ...shape,
      supersedesEventId: z.uuid(),
      correctionReason: z.string().min(1).max(1000),
    }),
  ])
}

const handoff = { kitRevisionId: id, manifestHash: hash, audienceId: id, destinationId: id }
const use = {
  kitRevisionId: id,
  audienceId: id,
  evidenceKind: z.enum(['NAMED_OWNER_CONFIRMATION', 'VERIFIABLE_PUBLICATION']),
  confirmingActorOrPublication: id,
}
const effort = {
  task: id,
  role: z.enum(['CUSTOMER', 'OPERATOR']),
  minutes: z.number().int().nonnegative().max(10_000_000).nullable(),
  basis: z.enum(['MEASURED', 'ESTIMATED']),
}

// This is an offline evidence format, not authority to mutate native release state.
export const pilotEventSchema = z.union([
  record({
    kind: z.literal('PARTICIPATION'),
    releaseId: z.null(),
    sourceRef: id,
    payload: z.strictObject({
      agreementId: id,
      category: z.enum(['PAID_PILOT', 'SUBSCRIPTION']),
      effectiveFrom: time,
      effectiveUntil: time.nullable(),
    }),
  }),
  record({
    kind: z.literal('RELEASE_REGISTERED'),
    sourceRef: id,
    payload: z.strictObject({
      canonicalReleaseId: id,
      ownerId: id,
      buyerId: id,
      factReviewerId: id,
      intakeAt: time,
      readyAt: time.nullable(),
      authorityRef: id,
    }),
  }),
  record({
    kind: z.literal('QUALIFIED'),
    provenance: z.literal('CUSTOMER_CONFIRMED'),
    sourceRef: id,
    payload: z.strictObject({
      eligible: z.boolean(),
      decisionRef: id,
      audiences: z.array(audience).min(1),
    }),
  }),
  record({
    kind: z.literal('REQUIREMENTS_REVISED'),
    payload: z.strictObject({
      reason: z.string().min(1).max(1000),
      audiences: z.array(audience).min(1),
    }),
  }),
  record({
    kind: z.literal('WITHDRAWN'),
    payload: z.strictObject({
      reason: z.string().min(1).max(1000),
    }),
  }),
  record({
    kind: z.literal('KIT_APPROVED'),
    provenance: z.literal('CUSTOMER_CONFIRMED'),
    sourceRef: id,
    payload: z.strictObject({
      kitRevisionId: id,
      manifestHash: hash,
      reviewerId: id,
      mode: z.enum(['ASSISTED_MANUAL', 'NATIVE']),
      checklistRef: id,
      audiences: z.array(audience).min(1),
    }),
  }),
  record({
    kind: z.literal('HANDOFF_RECORDED'),
    sourceRef: id,
    payload: z.strictObject({ ...handoff, status: z.literal('CONFIRMED'), receiptRef: id }),
  }),
  record({
    kind: z.literal('HANDOFF_RECORDED'),
    payload: z.strictObject({
      ...handoff,
      status: z.enum(['FAILED', 'UNKNOWN']),
      receiptRef: id.nullable(),
    }),
  }),
  record({
    kind: z.literal('USE_CONFIRMED'),
    sourceRef: id,
    payload: z.strictObject({
      ...use,
      status: z.literal('VERIFIED'),
      verifiedBy: id,
      verifiedAt: time,
    }),
  }),
  record({
    kind: z.literal('USE_CONFIRMED'),
    payload: z.strictObject({
      ...use,
      status: z.enum(['PENDING', 'RETRACTED']),
      verifiedBy: id.nullable(),
      verifiedAt: time.nullable(),
    }),
  }),
  record({
    kind: z.literal('FACT_CORRECTION'),
    payload: z.strictObject({
      kitRevisionId: id,
      claimIds: z.array(id),
      classification: z.enum(['FACTUAL', 'STYLE']),
      severity: z.enum(['MINOR', 'MAJOR', 'CRITICAL']),
      resolutionRevisionId: id.nullable(),
    }),
  }),
  record({
    kind: z.literal('EFFORT_RECORDED'),
    payload: z.discriminatedUnion('phase', [
      z.strictObject({
        ...effort,
        phase: z.literal('CURRENT'),
        comparableReleaseId: id.nullable(),
      }),
      z.strictObject({ ...effort, phase: z.literal('BASELINE'), comparableReleaseId: id }),
    ]),
  }),
  record({
    kind: z.literal('COST_RECORDED'),
    releaseId: id.nullable(),
    sourceRef: id,
    payload: z.strictObject({
      lineId: id,
      category: z.enum(['AI', 'CAPTURE', 'RENDERING', 'STORAGE_DELIVERY', 'HUMAN_ASSISTANCE']),
      quantity: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
      amountMicros: micros,
      currency,
      status: z.enum(['ESTIMATED', 'SETTLED']),
    }),
  }),
  record({
    kind: z.literal('PAYMENT_RECORDED'),
    releaseId: id.nullable(),
    sourceRef: id,
    payload: z.strictObject({
      lineId: id,
      agreementId: id,
      amountMicros: micros,
      currency,
      status: z.enum(['COMMITTED', 'AUTHORIZED', 'FAILED', 'COLLECTED', 'REFUNDED']),
    }),
  }),
  record({
    kind: z.literal('RENEWAL_RECORDED'),
    releaseId: z.null(),
    sourceRef: id,
    payload: z.strictObject({
      agreementId: id,
      status: z.enum(['INTENT', 'PAID', 'DECLINED']),
    }),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal('EVIDENCE_REMOVED'),
    releaseId: z.null(),
    supersedesEventId: z.null(),
    correctionReason: z.null(),
    payload: z.strictObject({
      removedSourceRef: id,
      reason: z.string().min(1).max(1000),
    }),
  }),
])

export type PilotEvent = z.infer<typeof pilotEventSchema>

export const pilotReportParametersSchema = z.strictObject({
  metricVersion: z.literal('1'),
  cohortMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  asOf: time,
  followupDays: z.number().int().min(1).max(3660),
})

export type PilotReportParameters = z.infer<typeof pilotReportParametersSchema>
