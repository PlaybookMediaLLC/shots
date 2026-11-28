'use client'

import { ArrowSquareOut } from '@phosphor-icons/react'
import Link from 'next/link'
import { Group, Section } from '@/components/platform-ui'

/**
 * API Documentation summary card linking to Scalar (/api-reference), OpenAPI
 * 3.1 JSON, agent docs, and llms.txt, with API key security guidance.
 */
export function ApiDocsCard() {
  return (
    <Section title="API Documentation">
      <Group>
        <div className="flex flex-col gap-3 p-5">
          <div className="flex items-center gap-2">
            <Link
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground hover:underline"
              href="/api-reference"
              rel="noopener noreferrer"
              target="_blank"
            >
              API Documentation
              <ArrowSquareOut aria-hidden="true" className="size-4 text-muted-foreground" />
            </Link>
          </div>
          <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
            <p>
              Send your workspace API key in{' '}
              <code className="font-mono text-foreground/85">X-API-Key</code> for the Shots REST
              API (<code className="font-mono text-foreground/85">/api/v1/*</code>), or{' '}
              <code className="font-mono text-foreground/85">Authorization: Bearer</code> for MCP
              clients without OAuth.
            </p>
            <p>
              Keep your API keys secure and never expose them in client-side code or public
              repositories.
            </p>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
            <Link className="underline underline-offset-4 hover:text-foreground" href="/api-reference">
              Interactive reference
            </Link>
            <a className="underline underline-offset-4 hover:text-foreground" href="/openapi.json">
              OpenAPI 3.1 JSON
            </a>
            <Link className="underline underline-offset-4 hover:text-foreground" href="/docs/agents">
              Agent setup docs
            </Link>
            <a className="underline underline-offset-4 hover:text-foreground" href="/llms.txt">
              llms.txt
            </a>
            <Link
              className="underline underline-offset-4 hover:text-foreground"
              href="/settings/developers"
            >
              Developer tools &amp; inbound sources
            </Link>
          </div>
        </div>
      </Group>
    </Section>
  )
}
