import { Group, Pill, type PillTone, Row } from '@/components/platform-ui'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import type { AuditLog } from './WorkspaceAuditSettings'

type WorkspaceAuditLogListProps = { logs: AuditLog[]; search?: string }

const outcomeTones: Record<string, PillTone> = { DENIED: 'red', FAILED: 'red', SUCCEEDED: 'green' }

export function WorkspaceAuditLogList({ logs, search }: WorkspaceAuditLogListProps) {
  return (
    <Group>
      {logs.length === 0 ? (
        <Row>
          <p className="text-sm text-muted-foreground">
            {search ? 'No events match your search.' : 'No audit events have been recorded.'}
          </p>
        </Row>
      ) : (
        logs.map((log) => (
          <div className="flex items-center gap-4 px-5 py-4" key={log.id}>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-sm text-foreground">{log.action}</p>
              <p className="truncate text-xs text-muted-foreground">
                {log.actorDisplay ?? 'System'} · {log.entityType.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')} ·{' '}
                {new Date(log.createdAt).toLocaleString()}
              </p>
              <Disclosure className="mt-2 text-xs text-muted-foreground">
                <DisclosureTrigger>Event details{log.entityId ? ` · ${log.entityId}` : ''}</DisclosureTrigger>
                <DisclosureContent>
                  <dl className="mt-2 grid gap-1">
                    <div><dt className="inline font-medium">Event ID: </dt><dd className="inline break-all">{log.id}</dd></div>
                    {log.entityId ? <div><dt className="inline font-medium">Entity ID: </dt><dd className="inline break-all">{log.entityId}</dd></div> : null}
                    {Object.entries(log.metadata ?? {}).map(([key, value]) => <div key={key}><dt className="inline font-medium">{key.replace(/([a-z])([A-Z])/g, '$1 $2')}: </dt><dd className="inline break-all">{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>)}
                  </dl>
                </DisclosureContent>
              </Disclosure>
            </div>
            <Pill tone={outcomeTones[log.outcome] ?? 'gray'}>
              <span className="capitalize">{log.outcome.toLowerCase()}</span>
            </Pill>
          </div>
        ))
      )}
    </Group>
  )
}
