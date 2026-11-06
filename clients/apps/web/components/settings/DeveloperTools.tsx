'use client'

import { PLUGIN_URL } from '@/lib/agents/mcp-clients'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Group, Row, Section } from '@/components/platform-ui'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  clearDebugLog,
  DEBUG_LOG_LIMITS,
  debugLog,
  debugLoggingEnabled,
  downloadDebugLog,
  readDebugLog,
  setDebugLogging,
} from '@/lib/debug-log'

/**
 * Development mode and debug logging (RFC 024). Development mode is a
 * preference that follows you; debug logging lives in this browser only.
 */
export function DeveloperTools() {
  const { preferences, save, status } = usePreferences()
  const [state, run] = useSaveState()
  const [logging, setLogging] = useState(false)
  const [count, setCount] = useState(0)

  useEffect(() => {
    setLogging(debugLoggingEnabled())
    setCount(readDebugLog().length)
    const refresh = window.setInterval(() => setCount(readDebugLog().length), 2000)
    return () => window.clearInterval(refresh)
  }, [])

  return (
    <Section
      description="Tools for people building on Shots. Neither shows credentials, other workspaces' data, or database details."
      title="Developer tools"
    >
      <Group>
        <Row
          description="Shows the IDs of profiles, drafts, accounts and media next to them, each with a copy button, for use with the API and webhooks."
          label="Development mode"
        >
          <div className="flex items-center gap-3">
            <SaveStatus state={state} />
            <Switch
              aria-label="Development mode"
              checked={preferences?.developerMode ?? false}
              disabled={status !== 'ready'}
              onCheckedChange={(developerMode) => void run(() => save({ developerMode }))}
            />
          </div>
        </Row>
        <Row
          description={`Keeps a log of the requests this browser makes (method, path, status, timing) and of errors, to share with support. It stays in this browser and is never uploaded. Values that look like keys, tokens, emails or card numbers are removed before anything is stored, but the log can still name drafts, accounts and API routes, and it slows the app slightly. It keeps the last ${DEBUG_LOG_LIMITS.entries} entries.`}
          label="Debug logging"
        >
          <Switch
            aria-label="Debug logging"
            checked={logging}
            onCheckedChange={(on) => {
              setDebugLogging(on)
              setLogging(on)
              if (on) debugLog('event', 'Debug logging turned on')
              setCount(readDebugLog().length)
            }}
          />
        </Row>
        <Row description={`${count} stored ${count === 1 ? 'entry' : 'entries'} in this browser.`} label="Stored logs">
          <div className="flex flex-wrap gap-2">
            <Button disabled={count === 0} onClick={downloadDebugLog} type="button" variant="outline">
              Download logs
            </Button>
            <Button
              disabled={count === 0}
              onClick={() => {
                clearDebugLog()
                setCount(0)
              }}
              type="button"
              variant="outline"
            >
              Clear logs
            </Button>
          </div>
        </Row>
      </Group>
      <Group>
        <Row description="The REST API reference, its OpenAPI document, the developer guide, MCP setup and support." label="Developer resources">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <li>
              <Link className="underline" href="/api-reference">
                API reference
              </Link>
            </li>
            <li>
              <a className="underline" href="/openapi.json">
                OpenAPI document
              </a>
            </li>
            <li>
              <Link className="underline" href="/developers">
                Developer guide
              </Link>
            </li>
            <li>
              <Link className="underline" href="/settings/ai-agents">
                MCP and agents
              </Link>
            </li>
            <li>
              <a
                className="underline"
                href={PLUGIN_URL}
                rel="noreferrer"
                target="_blank"
              >
                Agent plugin for Claude Code and Codex
              </a>
            </li>
            <li>
              <Link className="underline" href="/contact">
                Support
              </Link>
            </li>
          </ul>
        </Row>
      </Group>
    </Section>
  )
}
