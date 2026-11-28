import { NextResponse } from 'next/server'
import {
  unsubscribeAutomationEmailsContract,
  unsubscribeAutomationEmailsGetContract,
} from '@/lib/api/contracts/settings-platform'
import { route } from '@/lib/api/route'
import { publicAccess } from '@/lib/api/route-auth'
import { serviceBackend } from '@/lib/backend/sdk'

const HTML_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'text/html; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** RFC 8058 one-click unsubscribe and browser form confirmation handler. */
export const POST = route(unsubscribeAutomationEmailsContract, {
  auth: publicAccess,
  handler: async ({ query, request }) => {
    const result = await serviceBackend().unsubscribeAutomationEmails(query.token)
    const accept = request.headers.get('accept') ?? ''
    if (accept.includes('text/html') && !accept.includes('application/json')) {
      return new NextResponse(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — Shots</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:4rem auto;padding:0 1rem;color:#111"><h1 style="font-size:1.25rem;margin-bottom:0.5rem">You are unsubscribed from automation emails</h1><p style="color:#555;line-height:1.5">You will no longer receive scheduled draft or queue reminder emails from Shots. You can re-enable Automation Emails anytime in Settings &rarr; Notifications.</p></body></html>',
        { headers: HTML_HEADERS, status: 200 }
      )
    }
    return result
  },
})

/** Safe confirmation page so email link-scanners prefetching GET never unsubscribe the user. */
export const GET = route(unsubscribeAutomationEmailsGetContract, {
  auth: publicAccess,
  handler: async ({ query }) => {
    const action = escapeHtmlAttr(
      `/api/v1/email/unsubscribe?token=${encodeURIComponent(query.token)}`
    )
    return new NextResponse(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe — Shots</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:4rem auto;padding:0 1rem;color:#111"><h1 style="font-size:1.25rem;margin-bottom:0.5rem">Unsubscribe from automation emails?</h1><p style="color:#555;line-height:1.5;margin-bottom:1.25rem">Confirm below to stop receiving scheduled draft and queue reminder emails from Shots. You can turn them back on anytime in Settings &rarr; Notifications.</p><form method="POST" action="${action}"><button type="submit" style="background:#111;color:#fff;border:0;border-radius:6px;padding:0.625rem 1rem;font-size:0.9375rem;cursor:pointer">Confirm unsubscribe</button></form></body></html>`,
      { headers: HTML_HEADERS, status: 200 }
    )
  },
})
