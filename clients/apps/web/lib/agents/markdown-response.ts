import { buildAgentBriefMarkdown } from '@/lib/agents/agent-briefs'
import {
  BASE_URL,
  findAgentPage,
  normalizeAgentPath,
  renderAgentPageMarkdown,
  renderNotFoundMarkdown,
} from '@/lib/agents/site-content'
import { llmsTxt } from '@/lib/agents/llms'
import { getDocsMarkdown } from '@/lib/docs/source'

function markdownResponse(body: string, status: number, canonical: string): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      Vary: 'Accept, Accept-Encoding',
      Link: `<${canonical}>; rel="canonical"`,
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  })
}

const agentBriefPathPattern = /^\/docs\/agents\/([a-z0-9-]+)\.md$/i

export function agentMarkdownResponse(path: string): Response {
  const pathname = normalizeAgentPath(path)
  const briefMatch = agentBriefPathPattern.exec(pathname)
  if (briefMatch) {
    const markdown = buildAgentBriefMarkdown(briefMatch[1]!)
    if (markdown) {
      return markdownResponse(markdown, 200, `${BASE_URL}/docs/agents`)
    }
    return markdownResponse(renderNotFoundMarkdown(pathname), 404, `${BASE_URL}/docs/agents`)
  }
  const canonical = `${BASE_URL}${pathname === '/' ? '/' : pathname}`
  const page = findAgentPage(pathname)

  if (!page) {
    const doc = getDocsMarkdown(pathname)
    if (doc) {
      return markdownResponse(doc.content, 200, canonical)
    }
    return markdownResponse(renderNotFoundMarkdown(pathname), 404, canonical)
  }

  if (pathname === '/') {
    return markdownResponse(`${llmsTxt.trim()}\n`, 200, canonical)
  }

  return markdownResponse(renderAgentPageMarkdown(page), 200, canonical)
}
