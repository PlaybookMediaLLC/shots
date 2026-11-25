import { NextResponse } from 'next/server'
import { getDocsSearchEntries } from '@/lib/docs/source'

// The index comes from MDX files compiled at build time and never varies by request.
export const dynamic = 'force-static'

export function GET() {
  return NextResponse.json(getDocsSearchEntries(), {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  })
}
