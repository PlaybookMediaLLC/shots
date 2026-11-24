import {
  createReleaseEvidenceContract,
  listReleaseEvidenceContract,
} from '@/lib/api/contracts/release-evidence'
import { route } from '@/lib/api/route'
import { memberAccess, tenantAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Retain a bounded source snapshot with explicit provenance. */
export const POST = route(createReleaseEvidenceContract, {
  auth: memberAccess(createReleaseEvidenceContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).createReleaseEvidence(params.id, headers['idempotency-key'], body),
  status: (result) => (result.created ? 201 : 200),
})

/** List retained snapshots while suppressing unavailable or private machine content. */
export const GET = route(listReleaseEvidenceContract, {
  auth: tenantAccess(listReleaseEvidenceContract.access),
  handler: ({ access, params, query }) =>
    backendSDK(access).listReleaseEvidence(params.id, query.cursor),
})
