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

export function agentMarkdownResponse(path: string): Response {
  const pathname = normalizeAgentPath(path)
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
