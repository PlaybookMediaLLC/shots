import { Card, Cards } from 'fumadocs-ui/components/card'
import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { ComponentPropsWithoutRef } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { API_KEY_PLACEHOLDER, MCP_CLIENTS, MCP_TOOLS, MCP_URL } from '@/lib/agents/mcp-clients'
import { apiKeyScopeDescriptions, apiKeyScopes } from '@/lib/auth/api-key-scopes'
import { publicImageUrl } from '@/lib/assets/public-image'
import { cn } from '@/lib/utils'

function DocsImage({ className, src, alt, ...props }: ComponentPropsWithoutRef<'img'>) {
  const resolvedSrc = typeof src === 'string' && src.startsWith('/') ? publicImageUrl(src) : src
  return (
    <img
      {...props}
      alt={alt ?? ''}
      className={cn('rounded-none border border-border', className)}
      loading="lazy"
      src={resolvedSrc}
    />
  )
}

function ApiKeyScopesTable() {
  return (
    <div className="my-6 overflow-x-auto">
      <Table className="w-full text-left text-sm">
        <TableHeader>
          <TableRow className="border-b border-border">
            <TableHead className="whitespace-normal py-2 pr-4 font-medium text-foreground">
              Scope
            </TableHead>
            <TableHead className="whitespace-normal py-2 font-medium text-foreground">
              Permitted actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {apiKeyScopes.map((scope) => (
            <TableRow className="border-b border-border/60" key={scope}>
              <TableCell className="whitespace-normal py-2 pr-4 font-mono text-xs text-foreground">
                {scope}
              </TableCell>
              <TableCell className="whitespace-normal py-2 text-muted-foreground">
                {apiKeyScopeDescriptions[scope]}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function McpToolsTable() {
  return (
    <div className="my-6 overflow-x-auto">
      <Table className="w-full text-left text-sm">
        <TableHeader>
          <TableRow className="border-b border-border">
            <TableHead className="whitespace-normal py-2 pr-4 font-medium text-foreground">
              Tool
            </TableHead>
            <TableHead className="whitespace-normal py-2 pr-4 font-medium text-foreground">
              Scope
            </TableHead>
            <TableHead className="whitespace-normal py-2 font-medium text-foreground">
              Summary
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {MCP_TOOLS.map((tool) => (
            <TableRow className="border-b border-border/60" key={tool.name}>
              <TableCell className="whitespace-normal py-2 pr-4 font-mono text-xs text-foreground">
                {tool.name}
              </TableCell>
              <TableCell className="whitespace-normal py-2 pr-4 font-mono text-xs text-muted-foreground">
                {tool.scope}
              </TableCell>
              <TableCell className="whitespace-normal py-2 text-muted-foreground">
                {tool.summary}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function McpClientsList() {
  return (
    <div className="my-6 space-y-8">
      <p className="text-sm text-muted-foreground">
        Endpoint URL: <code className="font-mono text-foreground">{MCP_URL}</code>
      </p>
      {MCP_CLIENTS.map((client) => (
        <section className="space-y-3" id={client.id} key={client.id}>
          <h3 className="text-lg font-semibold tracking-tight text-foreground">{client.name}</h3>
          <p className="text-sm text-muted-foreground">{client.location}</p>
          <pre className="overflow-x-auto border border-border bg-fd-card p-4 font-mono text-xs leading-relaxed text-foreground">
            <code>{client.snippet(MCP_URL, API_KEY_PLACEHOLDER)}</code>
          </pre>
          <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
            {client.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}

export const docsMdxComponents = {
  ...defaultMdxComponents,
  ApiKeyScopesTable,
  Card,
  Cards,
  McpClientsList,
  McpToolsTable,
  img: DocsImage,
}
