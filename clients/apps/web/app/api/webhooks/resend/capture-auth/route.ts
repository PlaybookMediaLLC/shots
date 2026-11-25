import { z } from 'zod'
import {
  ingestResendCaptureAuthWebhookContract,
  resendSignatureSchema,
} from '@/lib/api/contracts/webhooks'
import { type Authenticate, route } from '@/lib/api/route'
import { AuthorizationError } from '@/lib/auth/access'
import { serviceBackend } from '@/lib/backend/sdk'

/**
 * Resend's signature headers. Public because Resend calls it; the backend
 * verifies the Svix signature over the exact body before reading anything.
 */
const resendHeaders: Authenticate<z.infer<typeof resendSignatureSchema>> = async ({ request }) => {
  const headers = resendSignatureSchema.safeParse({
    svixId: request.headers.get('svix-id'),
    svixSignature: request.headers.get('svix-signature'),
    svixTimestamp: request.headers.get('svix-timestamp'),
  })
  if (!headers.success) throw new AuthorizationError('Unauthorized webhook.', 401)
  return headers.data
}

/** Forward an inbound sign-in email notification for unattended capture sign-in (RFC 007A). */
export const POST = route(ingestResendCaptureAuthWebhookContract, {
  auth: resendHeaders,
  handler: async ({ access, body }) =>
    serviceBackend().receiveCaptureAuthEmail({ ...access, payload: body }),
})
