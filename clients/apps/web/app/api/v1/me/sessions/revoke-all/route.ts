import { NextResponse } from 'next/server'
import {
  revokeAllSessionsContract,
  revokeAllSessionsResultSchema,
} from '@/lib/api/contracts/settings-platform'
import { route } from '@/lib/api/route'
import { sessionAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

const SESSION_COOKIE_NAMES = [
  'better-auth.session_token',
  '__Secure-better-auth.session_token',
  'better-auth.session_data',
  '__Secure-better-auth.session_data',
] as const

/** Sign out of every active browser session and revoke OAuth tokens atomically. */
export const POST = route(revokeAllSessionsContract, {
  auth: sessionAccess,
  handler: async ({ access }) => {
    const result = revokeAllSessionsResultSchema.parse(
      await backendSDK({ ...access, organizationId: '' }).revokeAllSessions()
    )
    const response = NextResponse.json(result, { status: 200 })
    for (const name of SESSION_COOKIE_NAMES) {
      response.cookies.set(name, '', {
        httpOnly: true,
        maxAge: 0,
        path: '/',
        sameSite: 'lax',
        secure: name.startsWith('__Secure-'),
      })
    }
    return response
  },
})
