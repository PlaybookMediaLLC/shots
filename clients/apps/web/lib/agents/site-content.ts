import { platformAgentPages } from '@/lib/marketing/platform-pages'
import { claimsNote, comparisons, type ComparisonData } from '@/lib/seo/comparisons'
import { SITE_URL } from '@/lib/seo/metadata'
import { atLeast, PRODUCT_FACTS } from '@/lib/seo/product-facts'
import { TOOLS, TOOLS_HUB_PATH } from '@/lib/seo/tools'

export const BASE_URL = SITE_URL

export interface AgentSection {
  heading: string
  body: string
}

export interface AgentPage {
  path: string
  title: string
  summary: string
  points?: string[]
  /** Full page body, so the Markdown alternate carries the same substance as the HTML. */
  sections?: AgentSection[]
}

export const AGENT_PAGES: AgentPage[] = [
  {
    path: '/',
    title: 'Shots - Screenshot Editor & Mockup Maker',
    summary:
      'The signed-in Shots editor. Drop in a screenshot and add gradient backgrounds, browser mockups, shadows, 3D perspective, and animation, then export a PNG, JPEG, WebP, MP4, WebM, or GIF. Editing runs client side, so imported images are not uploaded merely to edit them; export compression sends the finished image to the server, which returns it without storing it. The editor is included in every paid plan, some capabilities require a higher plan, and editor exports have no watermark.',
    points: [
      `${atLeast(PRODUCT_FACTS.backgrounds)} gradient, mesh, and solid backgrounds`,
      'Safari, Chrome, and Arc browser mockups in light and dark',
      '3D perspective transforms and fully configurable shadows',
      `${PRODUCT_FACTS.animationPresets} animation presets with a keyframe timeline and video export`,
      'Import a tweet by URL and render it as an image',
      `Export up to ${PRODUCT_FACTS.maxExportScale}x resolution`,
    ],
  },
  {
    path: '/landing',
    title: 'Shots - Turn Every Release into a Launch',
    summary:
      'Product landing page for the Shots platform. A release (typed in, sent through the REST API with an X-API-Key, or delivered by a signed GitHub, GitLab, or custom webhook) becomes a cited launch spec, a campaign plan, on-brand visuals from the real product, and channel copy for X, LinkedIn, Instagram, Product Hunt, the changelog, and email. Every post needs a human approval before it can be scheduled. Launch intelligence is in early access; the open-source editor is included in every plan.',
    points: [
      'Launch spec: every claim cites the brief or a source; uncited claims become open questions',
      'Campaign plan: channels, angles, assets with capture hints, and a teaser, launch day, and follow-up timeline',
      'Visuals rendered by the editor with the workspace brand kit and critiqued before use',
      'Copy checked for channel limits, hype terms, unknown links, and uncited claims',
      'Server-side approval with six roles; API keys and agents cannot approve',
      'Durable scheduling: published only with a network receipt, uncertain deliveries held for a person',
      'SSO (SAML, OIDC), SCIM, append-only audit log, SIEM drains, and self-hosting with Docker and Helm',
    ],
  },
  {
    path: '/code',
    title: 'Code Studio: Code Images, Carousels and Videos - Shots',
    summary:
      'Code Studio turns a snippet, a diff, a GitHub pull request or a scripted terminal session into a code image, a carousel or a short video, then opens it as a Publish draft with the code as alt text. Images and videos render in the browser; code is stored only when you save a project to your workspace, and a GitHub link is read only when you import it. Included in every paid plan, with no watermark.',
    points: [
      `${PRODUCT_FACTS.codeThemes} syntax themes plus themes generated from your brand kit`,
      'Line highlight, focus and blur, annotations, diffs, file tabs, terminal frames and an attribution footer',
      'Carousels as PNGs or a LinkedIn PDF, and animated code as MP4, WebM or GIF in 9:16, 1:1 and 16:9',
      'Import from a GitHub file link with a line range, a pull request, a commit or a gist',
      'Post this: a Publish draft with the image attached, the code as alt text and an optional code reply',
    ],
  },
  {
    path: '/tweet',
    title: 'Tweet to Image: Turn Posts on X into Images - Shots',
    summary:
      'A focused tweet to image editor. Paste a link to a public post on X, pick a light or dark card and a gradient or transparent background, then export a PNG or copy it to the clipboard. Included in every plan for signed-in workspaces, with no export watermark.',
    points: [
      'Loads any public post from an x.com or twitter.com link',
      'Light and dark card styles with up to four photos',
      'Gradient, image, and pattern backgrounds, or a transparent backdrop',
      '2x and 4x PNG export, plus copy image to clipboard',
    ],
  },
  {
    path: '/remove-background',
    title: 'Remove Background from Image - Shots',
    summary:
      'A standalone background remover for signed-in workspaces. Drop in a PNG, JPG, WebP, or AVIF image and download a transparent PNG at the original resolution. The BiRefNet-lite model runs on the device with WebGPU, falling back to WebAssembly; the weights download once from Hugging Face and are cached, and the image itself is never uploaded. Included in every plan, and exports have no watermark.',
    points: [
      'On-device AI background removal, no image upload',
      'WebGPU acceleration with an automatic WebAssembly fallback',
      'Crisp or soft edge styles, switchable without rerunning the model',
      'Before and after comparison slider',
      'PNG, JPG, WebP, and AVIF input up to 50 MB',
    ],
  },
  {
    path: "/compress-video",
    title: "Compress Video Online: No Upload - Shots",
    summary:
      "A standalone video compressor. Drop in an MP4, MOV, WebM, or MKV file up to 1 GB, choose a quality level or a target size in MB, and download an MP4 with H.264 video and AAC audio. FFmpeg compiled to WebAssembly does the work inside the browser tab; the engine downloads once from a public CDN and is cached, and the video itself is not uploaded. Included in every plan for signed-in workspaces, with no export watermark.",
    points: [
      "Four quality levels, from visually identical to smallest file",
      "Target size mode that works out the bitrate to fit a limit such as 10 or 25 MB",
      "Optional downscale to 1080p, 720p, or 480p, never upscaling",
      "Keep, shrink, or remove the audio track",
      "Before and after file sizes with a preview of the result",
    ],
  },
  {
    path: TOOLS_HUB_PATH,
    title: 'Online Image Tools - Shots',
    summary:
      'Index of the standalone image utilities for signed-in workspaces: compress, convert, resize, crop, and rotate, plus six direct format converters. Every tool decodes, processes, and encodes in the browser using Canvas and Web Workers, so images are never uploaded. Batch input is supported and multiple results download as one zip. Included in every plan, and exports have no watermark.',
    points: [
      'Compress: four levels, live before and after file sizes',
      'Convert: PNG, JPG, and WebP in every direction',
      'Resize: exact pixels or percentage, aspect ratio locked by default',
      'Crop: drag a selection or type exact pixels, with ratio presets',
      'Rotate and flip: quarter turns plus horizontal and vertical mirroring',
    ],
  },
  {
    path: '/features',
    title: 'Features - Shots',
    summary:
      'Index of every Shots feature: backgrounds, browser mockups, device frames, 3D effects, animation, text and image overlays, and export formats.',
  },
  {
    path: '/features/screenshot-beautifier',
    title: 'Screenshot Beautifier - Shots',
    summary:
      'Background, padding, corner radius, and shadow controls that turn a raw screenshot into a presentable graphic.',
  },
  {
    path: '/features/social-media-graphics',
    title: 'Social Media Graphics Maker - Shots',
    summary:
      'Aspect ratio presets and styling for X/Twitter, Instagram, LinkedIn, and Product Hunt images.',
  },
  {
    path: '/features/animation-maker',
    title: 'Animation Maker - Shots',
    summary: `Keyframe timeline, ${PRODUCT_FACTS.animationPresets} animation presets, multi-slide slideshows, and in-browser MP4, WebM, and GIF encoding via FFmpeg WASM.`,
  },
  {
    path: '/features/3d-effects',
    title: '3D Effects - Shots',
    summary:
      'Perspective transforms, tilt, depth, and shadow controls for pseudo-3D product shots.',
  },
  {
    path: '/features/browser-mockups',
    title: 'Browser Mockups - Shots',
    summary:
      'Safari, Chrome, and Arc browser frames plus macOS window chrome, with editable URL bar text.',
  },
  {
    path: '/features/code-snippets',
    title: 'Code to Image Generator - Shots',
    summary:
      'Marketing overview of the code to image tool: syntax themes, gradient backgrounds, line numbers, window frame, and shareable links, positioned as an open-source ray.so and carbon.now.sh alternative.',
  },
  {
    path: '/for/developers',
    title: 'Shots for Developers',
    summary:
      'Ship README, changelog, and docs screenshots that look designed, plus a standalone code to image tool at /code.',
  },
  {
    path: '/for/marketers',
    title: 'Shots for Marketers',
    summary: 'Launch graphics, ad creative, and social posts built from product screenshots.',
  },
  {
    path: '/for/designers',
    title: 'Shots for Designers',
    summary: 'Present work with mockups, framing, and animation without leaving the browser.',
  },
  {
    path: '/docs',
    title: 'Shots API Documentation',
    summary:
      'HTTP API reference for editor utilities and /api/v1 tenant operations, both authenticated by a signed-in session or workspace API key, including schemas, rate limits, and error codes. The machine-readable contract is published at /openapi.json.',
    points: [
      'POST /api/screenshot - capture a live URL as a base64 PNG',
      'POST /api/export - recompress an image as PNG, JPEG, or WebP',
      'GET /api/tweet/{id} - fetch tweet JSON for tweet-to-image rendering',
      'GET /api/image-proxy - same-origin proxy for Twitter media',
      'GET and POST /api/v1/* - workspace operations requiring API-key scope or session permission',
      'OpenAPI 3.1 spec: /openapi.json',
    ],
  },
  {
    path: '/docs/authentication',
    title: 'Shots API Authentication',
    summary:
      'Editor utility endpoints require a signed-in session or a workspace API key with the artifact:read scope in X-API-Key, and per-IP limits apply on top. Workspace-scoped /api/v1 operations require an X-API-Key organization key or an authorized signed-in session.',
    points: [
      'Editor utility endpoints return 401 unauthorized without a session or X-API-Key workspace key',
      'Create a workspace API key in Settings → Developer API (/workspace/developers).',
      'Tenant /api/v1 operations enforce workspace permission, API-key scope, plan feature, and quota checks',
      'POST /api/screenshot is limited to 20 requests per minute per IP',
      'Rate-limited responses return HTTP 429 with Retry-After and X-RateLimit-* headers',
      'Cache-maintenance endpoints use a maintainer secret and are not part of the public surface',
    ],
  },
  {
    path: '/docs/agents',
    title: 'Connect AI agents to Shots',
    summary:
      'Setup for the Shots MCP server, which gives AI agents the workspace operations of the REST API with the same scopes, plan checks, and quotas. Agents that take a header send a workspace API key as a bearer token; Claude.ai, Claude Desktop, and ChatGPT connect through OAuth and a workspace owner or admin approves them. A key with post:schedule schedules approved posts; only a person approves.',
    points: [
      'Claude Code: claude mcp add --transport http shots <server URL> --header "Authorization: Bearer $SHOTS_API_KEY"',
      'Claude.ai and Claude Desktop: a custom connector on the /mcp-oauth-claude URL',
      'ChatGPT: a developer-mode connector on the /mcp-oauth-dynamic URL',
      'Cursor, VS Code, Windsurf, Gemini CLI, Codex CLI, and OpenCode: a config snippet with the server URL and a key',
      'Twelve tools named after the REST operations they mirror, filtered by the key scopes',
    ],
  },
  {
    path: '/developers',
    title: 'Shots Developer Portal',
    summary:
      'Developer entry point: API docs, OpenAPI spec, authentication and rate limits, quickstart requests, and agent files.',
    points: [
      'API docs: /docs',
      'Interactive API reference: /api-reference',
      'OpenAPI 3.1 spec: /openapi.json',
      'Authentication and rate limits: /docs/authentication',
      'AI agents over MCP: /docs/agents',
      'Agent overview: /llms.txt and /llms-full.txt',
    ],
  },
  {
    path: '/changelog',
    title: 'Changelog - Shots',
    summary: 'Release notes and shipped changes, newest first.',
  },
  {
    path: '/about',
    title: 'About Shots',
    summary:
      'Why Shots exists, what it offers, and how the open-source project is run.',
  },
  {
    path: '/contact',
    title: 'Contact Shots',
    summary: 'Ways to reach the maintainers: GitHub issues, X/Twitter, and email.',
  },
  {
    path: '/privacy-policy',
    title: 'Privacy Policy - Shots',
    summary:
      'How account and workspace data, browser-local editing, server-assisted operations, analytics, ads, and cookies are handled.',
  },
  {
    path: '/terms',
    title: 'Terms & Conditions - Shots',
    summary: 'Terms of use for Shots.',
  },
]

function cell(value: string): string {
  return value.replace(/\|/g, '\\|')
}

function renderFaqSection(faqs: { question: string; answer: string }[]): AgentSection {
  return {
    heading: 'FAQ',
    body: faqs.map((faq) => `### ${faq.question}\n\n${faq.answer}`).join('\n\n'),
  }
}

function comparisonSections(comparison: ComparisonData): AgentSection[] {
  return [
    ...(comparison.scopeNote
      ? [{ heading: 'These tools do different jobs', body: comparison.scopeNote }]
      : []),
    {
      heading: `${comparison.competitorName} pricing`,
      body: `${comparison.competitorPricing}

${claimsNote(comparison)}`,
    },
    {
      heading: `Where ${comparison.competitorName} falls short`,
      body: comparison.competitorLimitations.map((limitation) => `- ${limitation}`).join('\n'),
    },
    {
      heading: 'What Shots does differently',
      body: comparison.studioAdvantages.map((advantage) => `- ${advantage}`).join('\n'),
    },
    {
      heading: 'Feature comparison',
      body: [
        `| Feature | Shots | ${cell(comparison.competitorName)} |`,
        '| --- | --- | --- |',
        ...comparison.features.map(
          (feature) =>
            `| ${cell(feature.name)} | ${cell(feature.studio)} | ${cell(feature.competitor)} |`
        ),
      ].join('\n'),
    },
    { heading: 'Verdict', body: comparison.verdict },
    renderFaqSection(comparison.faqs.map((faq) => ({ question: faq.q, answer: faq.a }))),
  ]
}

function workspaceAwareSummary(value: string): string {
  return value
    .replace(/free,\s*no signup/gi, 'included in every plan')
    .replace(/no signup(?:\s+(?:needed|required))?/gi, 'a signed-in workspace is required')
}

/**
 * One agent page per comparison and per image tool, generated from the same
 * registries that drive the routes and the sitemap so they can never drift apart.
 */
for (const comparison of comparisons) {
  AGENT_PAGES.push({
    path: `/compare/${comparison.slug}`,
    title: comparison.metaTitle,
    summary: workspaceAwareSummary(`${comparison.tagline} ${comparison.metaDescription}`),
    sections: comparisonSections(comparison),
  })
}

for (const tool of TOOLS) {
  AGENT_PAGES.push({
    path: tool.slug,
    title: `${tool.title} - Shots`,
    summary: `${tool.intro} Runs entirely in the browser: the image is decoded, processed, and re-encoded locally and never uploaded. Included in every plan for signed-in workspaces, with no export watermark.`,
    points: tool.features,
    sections: [...(tool.sections ?? []), renderFaqSection(tool.faqs)],
  })
}

AGENT_PAGES.push(...platformAgentPages())

export const AGENT_RESOURCES = [
  { name: 'Interactive API reference', url: `${BASE_URL}/api-reference` },
  { name: 'API documentation', url: `${BASE_URL}/docs` },
  { name: 'Developer portal', url: `${BASE_URL}/developers` },
  { name: 'OpenAPI specification', url: `${BASE_URL}/openapi.json` },
  {
    name: 'Authentication and rate limits',
    url: `${BASE_URL}/docs/authentication`,
  },
  { name: 'AI agents and MCP setup', url: `${BASE_URL}/docs/agents` },
  { name: 'llms.txt', url: `${BASE_URL}/llms.txt` },
  { name: 'llms-full.txt', url: `${BASE_URL}/llms-full.txt` },
  { name: 'Sitemap', url: `${BASE_URL}/sitemap.xml` },
  { name: 'robots.txt', url: `${BASE_URL}/robots.txt` },
]

const LOCALE_PREFIX = /^\/(?:es|fr|de|ja|pt|ko|zh)(?=\/|$)/

export function normalizeAgentPath(pathname: string): string {
  const withoutLocale = pathname.replace(LOCALE_PREFIX, '')
  const trimmed = withoutLocale.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

export function findAgentPage(pathname: string): AgentPage | undefined {
  const normalized = normalizeAgentPath(pathname)
  return AGENT_PAGES.find((page) => page.path === normalized)
}

export function renderAgentPageMarkdown(page: AgentPage): string {
  const lines = [`# ${page.title}`, '', page.summary]

  if (page.points?.length) {
    lines.push('', ...page.points.map((point) => `- ${point}`))
  }

  for (const section of page.sections ?? []) {
    lines.push('', `## ${section.heading}`, '', section.body)
  }

  lines.push(
    '',
    '## Canonical URL',
    '',
    `${BASE_URL}${page.path === '/' ? '/' : page.path}`,
    '',
    '## Machine-readable resources',
    '',
    ...AGENT_RESOURCES.map((resource) => `- [${resource.name}](${resource.url})`)
  )

  return `${lines.join('\n')}\n`
}

export function renderNotFoundMarkdown(pathname: string): string {
  return [
    '# 404 Not Found',
    '',
    `No page exists at \`${pathname}\` on Shots.`,
    '',
    '## Where to look next',
    '',
    ...AGENT_RESOURCES.map((resource) => `- [${resource.name}](${resource.url})`),
    '',
    '## Main pages',
    '',
    ...AGENT_PAGES.slice(0, 12).map((page) => `- [${page.title}](${BASE_URL}${page.path})`),
    '',
  ].join('\n')
}

export function renderNotAcceptableMarkdown(accept: string): string {
  return [
    '# 406 Not Acceptable',
    '',
    `This URL cannot be represented as \`${accept}\`.`,
    '',
    '## Supported representations',
    '',
    '- `text/html` (default)',
    '- `text/markdown` (send `Accept: text/markdown`)',
    '',
    `Machine-readable index: ${BASE_URL}/llms.txt`,
    '',
  ].join('\n')
}
