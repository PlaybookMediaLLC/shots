import { API_KEY_PLACEHOLDER, MCP_CLIENTS, MCP_TOOLS, MCP_URL } from "@/lib/agents/mcp-clients";
import { BASE_URL } from "@/lib/agents/site-content";
import { PLAN_PRICES, planPriceSummary, usd } from "@/lib/billing/plans";
import { comparisons } from "@/lib/seo/comparisons";
import { guides } from "@/lib/seo/guides";
import { atLeast, PRODUCT_FACTS } from "@/lib/seo/product-facts";
import { CONVERTER_TOOLS, PRIMARY_TOOLS } from "@/lib/seo/tools";

const converterLinks = CONVERTER_TOOLS.map(
  (tool) => `${BASE_URL}${tool.slug}`,
).join(", ");

const primaryToolLines = PRIMARY_TOOLS.map(
  (tool) => `- ${tool.name}: ${BASE_URL}${tool.slug}`,
).join("\n");

const comparisonLines = comparisons
  .map((comparison) => `- vs ${comparison.competitorName}: ${BASE_URL}/compare/${comparison.slug}`)
  .join("\n");

const guideLines = guides
  .map((guide) => `- ${guide.title}: ${BASE_URL}/guides/${guide.slug}`)
  .join("\n");

const mcpToolLines = MCP_TOOLS.map(
  (tool) => `| ${tool.name} | ${tool.scope} | ${tool.summary} |`,
).join("\n");

const mcpClientSections = MCP_CLIENTS.map(
  (client) =>
    `#### ${client.name}\n\n${client.location}\n\n\`\`\`${client.language}\n${client.snippet(MCP_URL, API_KEY_PLACEHOLDER)}\n\`\`\`\n\n${client.steps.map((step) => `- ${step}`).join("\n")}`,
).join("\n\n");

const agentQuickstart = `## Agent Quickstart

Shots runs an MCP server for AI agents at ${MCP_URL}, served by the same backend as the REST API, with the same workspace permissions, plan checks, and quotas.

1. In a signed-in workspace, open Settings → AI agents (/settings/ai-agents) and create an agent key with only the scopes the agent needs.
2. Add the server to your agent with the key as a bearer token, using the configuration for your client at ${BASE_URL}/docs/agents.
3. Claude.ai, Claude Desktop, and ChatGPT connect through OAuth instead and ask a workspace owner or admin to approve.
4. Prefer HTTP? Every MCP tool mirrors an operation in ${BASE_URL}/openapi.json; send the same key in \`X-API-Key\`.

Setup for Claude Code, Claude.ai, ChatGPT, Cursor, VS Code, Windsurf, Gemini CLI, Codex CLI, and OpenCode: ${BASE_URL}/docs/agents. Agents can write, schedule, and publish posts to connected accounts, read releases, campaigns, the review queue, and the schedule, create drafts, upload assets, capture screenshots, and submit drafts for review. Posting needs the post:publish scope, which is off until someone ticks it. With post:schedule they schedule campaign posts a person approved. Only a person approves.`;

const comparisonRows = comparisons
  .map(
    (comparison) =>
      `| vs ${comparison.competitorName} | ${BASE_URL}/compare/${comparison.slug} | Feature comparison with ${comparison.competitorName} |`,
  )
  .join("\n");

const guideRows = guides
  .map(
    (guide) =>
      `| ${guide.title} | ${BASE_URL}/guides/${guide.slug} | ${guide.kind === "roundup" ? "Dated roundup with prices and limits" : "Step-by-step how-to"} |`,
  )
  .join("\n");

export const llmsTxt = `# Shots

> Shots is an open-source launch platform. It reads a software release, writes a cited launch brief, designs on-brand visuals, and drafts posts, and nothing ships until a person approves. It also includes a screenshot editor and browser-based image tools in every plan. Every plan is paid, and a signed-in workspace with an active subscription is required for everything; exports have no watermark.

## Overview

The launch platform turns a release (typed in, sent through the API, or delivered by a GitHub, GitLab, or custom webhook) into a launch brief where every claim cites a source, a campaign plan, visuals rendered with the workspace brand kit, and channel copy. Every post needs a human approval before it can be scheduled. Launch intelligence is in early access for design partners: ${BASE_URL}/design-partners.

The screenshot editor is included in every plan, with no watermark. Editing runs in the browser: imported images are not uploaded to edit them, saved designs are stored in the workspace, and export compression round-trips the finished image through the server without storing it. It is an open-source alternative to Pika Style, Shots.so (a separate product), and CleanShot X.

## Key Features

- ${atLeast(PRODUCT_FACTS.backgrounds)} gradient, mesh, and solid backgrounds
- Safari and Chrome browser mockups (light and dark)
- Device frames: Arc, Polaroid, glass, outline, border
- 3D perspective transforms and shadow effects
- ${PRODUCT_FACTS.animationPresets} animation presets with keyframe timeline editor
- Video export in MP4, WebM, and GIF
- Text and image overlays with ${PRODUCT_FACTS.fonts} Google Fonts
- Tweet-to-image and code-snippet-to-image capture
- On-device AI background remover with full-resolution transparent PNG output (${BASE_URL}/remove-background)
- In-browser video compressor with quality levels or a target size in MB, MP4 output (${BASE_URL}/compress-video)
- High-resolution export up to ${PRODUCT_FACTS.maxExportScale}x scale (PNG, JPEG, WebP)
- One-click styling presets
- Aspect ratio presets for every social platform

## Standalone Image Tools

Single-purpose utilities that run entirely in the browser (Canvas plus Web Workers) and do not call any API. They need a signed-in Shots workspace and are included in every plan. Batch input is supported; several results download as one zip.

${primaryToolLines}
- Converters: ${converterLinks}

## Pages

- Screenshot Editor (sign-in required): ${BASE_URL}/
- Editor alias (redirects to /): ${BASE_URL}/editor
- Product overview: ${BASE_URL}/landing
- Pricing: ${BASE_URL}/pricing
- Design partners (launch intelligence early access): ${BASE_URL}/design-partners
- Store screenshots (App Store and Google Play, signed in): ${BASE_URL}/create/store
- Code to Image: ${BASE_URL}/code
- Mockup Generator: ${BASE_URL}/mockup-generator
- Image Tools Hub: ${BASE_URL}/tools
- Remove Background: ${BASE_URL}/remove-background
- Compress Video: ${BASE_URL}/compress-video
- Features: ${BASE_URL}/features
- Screenshot Beautifier: ${BASE_URL}/features/screenshot-beautifier
- Social Media Graphics: ${BASE_URL}/features/social-media-graphics
- Animation Maker: ${BASE_URL}/features/animation-maker
- 3D Effects: ${BASE_URL}/features/3d-effects
- Browser Mockups: ${BASE_URL}/features/browser-mockups
- Code Snippet Images: ${BASE_URL}/features/code-snippets
- Audience Hub: ${BASE_URL}/for
- For Developers: ${BASE_URL}/for/developers
- For Marketers: ${BASE_URL}/for/marketers
- For Designers: ${BASE_URL}/for/designers
- Comparison Hub: ${BASE_URL}/compare
- Guides Hub: ${BASE_URL}/guides
- Changelog: ${BASE_URL}/changelog
- About: ${BASE_URL}/about
- Contact: ${BASE_URL}/contact
- Privacy Policy: ${BASE_URL}/privacy-policy
- Terms & Conditions: ${BASE_URL}/terms

## Developer Resources

- API Documentation: ${BASE_URL}/docs
- Developer Portal: ${BASE_URL}/developers
- Interactive API Reference: ${BASE_URL}/api-reference
- OpenAPI Specification (OpenAPI 3.1, JSON): ${BASE_URL}/openapi.json
- API Authentication and Rate Limits: ${BASE_URL}/docs/authentication
- AI Agents and MCP Setup: ${BASE_URL}/docs/agents
- MCP Server: ${MCP_URL}
- llms.txt: ${BASE_URL}/llms.txt
- llms-full.txt: ${BASE_URL}/llms-full.txt
- Sitemap: ${BASE_URL}/sitemap.xml
- robots.txt: ${BASE_URL}/robots.txt

The editor utility endpoints under paths such as \`/api/screenshot\` require a signed-in session or a workspace API key with the artifact:read scope in \`X-API-Key\`, and per-IP limits apply on top. Create a workspace API key in Settings → Developer API (/settings/developers). Workspace-scoped \`/api/v1\` operations require an organization key in \`X-API-Key\` or an authorized signed-in session. Every error is JSON with a stable \`code\`, a \`message\`, and a \`hint\`. Any page also serves Markdown when the request sends \`Accept: text/markdown\`.

${agentQuickstart}

## Internationalization

Available in 8 languages: English (default), Spanish (/es), French (/fr), German (/de), Japanese (/ja), Portuguese (/pt), Korean (/ko), Chinese (/zh).

## Comparison Pages

${comparisonLines}

## Guides

${guideLines}

## Pricing

Plans: Pro (${planPriceSummary('pro')}), Business (${planPriceSummary('business')}), and Enterprise (${planPriceSummary('enterprise')}). There is no free plan. A signed-in workspace is required on every plan. The screenshot editor, media and advanced queues are included in every plan, and exports have no watermark. Launch intelligence is in early access for design partners. Details: ${BASE_URL}/pricing

## Technology

Next.js 16, React 19, TypeScript, HTML Canvas, Tailwind CSS, Zustand, FFmpeg WASM for video encoding, Cloudflare R2 for assets.

## Use Cases

- Launch briefs, visuals, and approved posts for each software release
- Social media graphics (Twitter/X, Instagram, LinkedIn, Product Hunt)
- SaaS product screenshots for landing pages and documentation
- Developer portfolio and project showcase images
- Marketing presentations and pitch decks
- Animated slideshows and video content

## Target Audience

Software teams that ship releases, plus developers, designers, and marketers who need product visuals.

## Contact

- Website: ${BASE_URL}
- Email: team@playbookmedia.io

## Full Documentation

For the complete, detailed version of this document, see: ${BASE_URL}/llms-full.txt
`;

export const llmsFullTxt = `# Shots - Complete Reference

> Shots is an open-source launch platform. It reads a software release, writes a cited launch brief, designs on-brand visuals, and drafts posts, and nothing ships until a person approves. It also includes a screenshot editor and browser-based image tools in every plan. Every plan is paid, and a signed-in workspace with an active subscription is required for everything; exports have no watermark.

## What is Shots?

Shots is a paid launch platform; there is no free plan. A release, typed in, sent through the API, or delivered by a GitHub, GitLab, or custom webhook, becomes a launch brief where every claim cites a source, a campaign plan, visuals rendered with the workspace brand kit, and channel copy for X, LinkedIn, Instagram, Product Hunt, the changelog, and email. Every post needs a human approval before it can be scheduled. Launch intelligence is in early access for design partners (${BASE_URL}/design-partners).

Shots also includes a browser-based screenshot editor in every plan, with no watermark. Editing runs in the browser, so imported images are not uploaded to edit them; saved designs are stored in the workspace, and export compression round-trips the finished image through the server without storing it. It is open source under the Apache 2.0 license.

The editor is an open-source alternative to Pika Style, Shots.so (a separate product), and CleanShot X for images on social media, landing pages, documentation, and presentations.

## Complete Feature List

### Backgrounds
- ${atLeast(PRODUCT_FACTS.backgrounds)} backgrounds (linear, radial, mesh, conic, solid)
- Solid color backgrounds with custom color picker
- Paper texture backgrounds
- Pattern backgrounds
- Custom image backgrounds
- Transparent background support

### Browser Mockups
- Safari browser frame (light and dark mode)
- Chrome browser frame (light and dark mode)
- Arc browser frame
- Minimal window frame
- Custom URL bar text

### Device Frames
- macOS window chrome
- Polaroid-style frame
- Glass morphism frame
- Outline frame
- Border frame with customizable radius

### 3D Effects
- Perspective transforms (X, Y, Z rotation)
- Tilt effects
- Depth-of-field simulation
- Custom shadow with blur, spread, offset, and color

### Standalone Image Tools
- Compress: light, balanced, strong, and extreme levels
- Convert: PNG, JPG, and WebP, with a chosen background behind transparency
- Resize: by exact pixels or percentage, with stepped downscaling
- Crop: drag or type, with 1:1, 16:9, 4:3, 3:2, and 9:16 presets
- Rotate and flip: 90, 180, 270 degrees plus mirroring
- Batch input for every tool except crop, downloaded as a zip
- All of it runs in the browser and calls no API; a signed-in Shots account is required

### Image Editing
- Resize and scale
- Opacity control
- Border radius (0 to fully rounded)
- Padding and inset controls
- Shadow with full customization
- Position and alignment

### Text Overlays
- Multiple text layers
- ${PRODUCT_FACTS.fonts} Google Fonts across sans-serif, serif, display, handwriting, and monospace
- Custom font size, weight, color
- Text shadow and positioning
- Letter spacing and line height

### Animation & Video
- ${PRODUCT_FACTS.animationPresets} animation presets (zoom in/out, pan, Ken Burns, tilt, fade, bounce, slide, etc.)
- Keyframe timeline editor
- Multi-slide slideshows
- Video export: MP4, WebM, GIF
- Custom duration and easing per animation
- FFmpeg WASM-based encoding (runs in browser)

### Import
- Drag and drop images
- Paste from clipboard
- Import tweets by URL (renders as image)
- Import code snippets (syntax highlighted)

### Export
- PNG (lossless, up to ${PRODUCT_FACTS.maxExportScale}x resolution)
- JPEG (configurable quality)
- WebP (configurable quality)
- MP4 video
- WebM video
- GIF animation
- Copy to clipboard
- Scale: 1x, 2x, 3x, 4x, 5x

### Templates & Presets
- One-click styling presets
- Aspect ratio presets: Auto, 1:1, 4:3, 16:9, 9:16, 4:5, 2:3, 3:2, 21:9
- Social platform presets (Twitter, Instagram, LinkedIn, etc.)

## All Pages

### Core
| Page | URL | Description |
|------|-----|-------------|
| Screenshot Editor | ${BASE_URL}/ | Main canvas editor for signed-in workspaces (redirects to sign-in) |
| Editor alias | ${BASE_URL}/editor | Redirects to / |
| Landing | ${BASE_URL}/landing | Launch platform overview |
| Pricing | ${BASE_URL}/pricing | Pro, Business, and Enterprise plans |
| Design Partners | ${BASE_URL}/design-partners | Early access to launch intelligence |
| Mockup Generator | ${BASE_URL}/mockup-generator | iPhone, MacBook, and Apple Watch mockups with 3D angles and multi-device layouts |
| Image Tools Hub | ${BASE_URL}/tools | Index of the standalone image utilities |
| Remove Background | ${BASE_URL}/remove-background | On-device AI background remover that exports a transparent PNG |
| Compress Video | ${BASE_URL}/compress-video | FFmpeg WebAssembly video compressor: quality levels or a target size in MB, MP4 output |

### Image Tools
Standalone, single-purpose utilities for signed-in workspaces. Each decodes, processes, and re-encodes the image locally with Canvas and a Web Worker, and calls no API. Batch input downloads as one zip.

| Page | URL | Description |
|------|-----|-------------|
| Compress Image | ${BASE_URL}/compress-image | Four compression levels with before and after sizes |
| Convert Image | ${BASE_URL}/convert-image | PNG, JPG, and WebP in every direction |
| Resize Image | ${BASE_URL}/resize-image | Exact pixels or percentage, aspect ratio locked by default |
| Crop Image | ${BASE_URL}/crop-image | Drag a selection or type pixels, with ratio presets |
| Rotate Image | ${BASE_URL}/rotate-image | Quarter turns plus horizontal and vertical flips |
| PNG to JPG | ${BASE_URL}/png-to-jpg | Direct converter with a background colour for transparency |
| JPG to PNG | ${BASE_URL}/jpg-to-png | Direct converter to a lossless format |
| PNG to WebP | ${BASE_URL}/png-to-webp | Direct converter that keeps transparency |
| WebP to PNG | ${BASE_URL}/webp-to-png | Direct converter for tools that cannot read WebP |
| JPG to WebP | ${BASE_URL}/jpg-to-webp | Direct converter for smaller web images |
| WebP to JPG | ${BASE_URL}/webp-to-jpg | Direct converter for maximum compatibility |

### Features
| Page | URL | Description |
|------|-----|-------------|
| Features Hub | ${BASE_URL}/features | All features overview |
| Screenshot Beautifier | ${BASE_URL}/features/screenshot-beautifier | Background and styling features |
| Social Media Graphics | ${BASE_URL}/features/social-media-graphics | Social platform image creation |
| Animation Maker | ${BASE_URL}/features/animation-maker | Animation timeline and video export |
| 3D Effects | ${BASE_URL}/features/3d-effects | Perspective and depth effects |
| Browser Mockups | ${BASE_URL}/features/browser-mockups | Safari, Chrome, Arc frames |
| Background Remover | ${BASE_URL}/remove-background | On-device AI background removal |

### Audience Pages
| Page | URL | Description |
|------|-----|-------------|
| For Developers | ${BASE_URL}/for/developers | Developer-focused use cases |
| For Marketers | ${BASE_URL}/for/marketers | Marketing-focused use cases |
| For Designers | ${BASE_URL}/for/designers | Design-focused use cases |

### Comparison Pages
| Page | URL | Description |
|------|-----|-------------|
${comparisonRows}

### Guides
| Page | URL | Description |
|------|-----|-------------|
| Guides Hub | ${BASE_URL}/guides | Index of how-to guides and tool roundups |
${guideRows}

### Company
| Page | URL | Description |
|------|-----|-------------|
| About | ${BASE_URL}/about | About the project and team |
| Contact | ${BASE_URL}/contact | Ways to reach us |
| Privacy Policy | ${BASE_URL}/privacy-policy | How we handle data |
| Terms & Conditions | ${BASE_URL}/terms | Usage terms |
| Changelog | ${BASE_URL}/changelog | Release notes and updates |

## Internationalization

Shots is available in 8 languages with subpath routing:

| Language | Prefix | Example |
|----------|--------|---------|
| English (default) | / | ${BASE_URL}/about |
| Spanish | /es | ${BASE_URL}/es/about |
| French | /fr | ${BASE_URL}/fr/about |
| German | /de | ${BASE_URL}/de/about |
| Japanese | /ja | ${BASE_URL}/ja/about |
| Portuguese | /pt | ${BASE_URL}/pt/about |
| Korean | /ko | ${BASE_URL}/ko/about |
| Chinese | /zh | ${BASE_URL}/zh/about |

Locale detection: URL path > cookie > Accept-Language header > default (English).

## Developer and API Reference

### Discovery

| Resource | URL | Format |
|----------|-----|--------|
| API Documentation | ${BASE_URL}/docs | HTML |
| Developer Portal | ${BASE_URL}/developers | HTML |
| Interactive API Reference | ${BASE_URL}/api-reference | HTML |
| OpenAPI Specification | ${BASE_URL}/openapi.json | OpenAPI 3.1 JSON |
| API Authentication and Rate Limits | ${BASE_URL}/docs/authentication | HTML |
| AI Agents and MCP Setup | ${BASE_URL}/docs/agents | HTML |
| MCP Server | ${MCP_URL} | MCP Streamable HTTP |
| llms.txt | ${BASE_URL}/llms.txt | Markdown |
| llms-full.txt | ${BASE_URL}/llms-full.txt | Markdown |
| Sitemap | ${BASE_URL}/sitemap.xml | XML |
| robots.txt | ${BASE_URL}/robots.txt | text |

### Authentication

The editor utility endpoints require a signed-in session or a workspace API key with the artifact:read scope in \`X-API-Key\`; a request with neither returns 401 with code \`unauthorized\`. A workspace without an active paid plan gets 403 with code \`workspace_feature_not_entitled\`; there is no free plan. Create a workspace API key in Settings → Developer API (/settings/developers). Per-IP limits apply on top: \`POST /api/screenshot\` allows 20 requests per minute per IP and answers 429 with \`Retry-After\` and \`X-RateLimit-*\` headers. Workspace-scoped \`/api/v1\` operations require an organization key in \`X-API-Key\` or an authorized signed-in session, plus the declared permission, scope, feature, and quota checks.

### Endpoints

| Operation ID | Method | Path | Description |
|--------------|--------|------|-------------|
| captureScreenshot | POST | /api/screenshot | Capture a live URL as a base64 PNG |
| optimizeExportImage | POST | /api/export | Recompress an image as PNG, JPEG, or WebP |
| getTweet | GET | /api/tweet/{id} | Fetch a tweet payload by status ID |
| proxyTwitterImage | GET | /api/image-proxy | Same-origin proxy for Twitter media |
| getOpenApiSpec | GET | /openapi.json | This API's OpenAPI 3.1 document |
| getLlmsTxt | GET | /llms.txt | Markdown site overview |
| getLlmsFullTxt | GET | /llms-full.txt | Full Markdown reference |

### Error format

Every failing request returns JSON:

\`\`\`json
{
  "error": "URL is required",
  "code": "invalid_request",
  "message": "URL is required",
  "hint": "Send a JSON body with a url string.",
  "status": 400,
  "documentation": "${BASE_URL}/docs#errors"
}
\`\`\`

\`code\` is stable and safe to branch on. \`error\` and \`message\` carry the same human-readable text.

### Markdown content negotiation

Every page URL serves Markdown when the request prefers it:

\`\`\`
curl -H "Accept: text/markdown" ${BASE_URL}/
\`\`\`

Responses set \`Content-Type: text/markdown; charset=utf-8\` and \`Vary: Accept, Accept-Encoding\`. A request that accepts neither \`text/html\` nor \`text/markdown\` is answered with 406. Unknown paths return 404 with a Markdown body listing where to look next.

### MCP server

${MCP_URL} is the Shots MCP server (Streamable HTTP). Send a workspace API key as \`Authorization: Bearer ss_...\`, or connect an OAuth client through ${MCP_URL.replace(/\/mcp$/, "")}/mcp-oauth-dynamic. Every call passes the same scope, plan, and quota checks as the REST API, and refusals use the error format above. An agent sees only the tools its key's scopes allow:

| Tool | Scope | Does |
|------|-------|------|
${mcpToolLines}

No tool approves; a person does that in Shots. createPost writes and publishes new posts with the post:publish scope, which is off until someone ticks it, and a workspace that requires approval keeps that rule. The campaign scheduling tools need post:schedule and take only posts and visuals a person approved.

### MCP client configuration

${mcpClientSections}

No official CLI tool is published yet.

## Technology Stack

- **Framework**: Next.js 16 with App Router
- **UI**: React 19, Tailwind CSS, Radix UI primitives
- **State**: Zustand with temporal (undo/redo)
- **Canvas**: HTML Canvas with modern-screenshot for rendering
- **Video**: FFmpeg WASM for browser-based encoding
- **Assets**: Cloudflare R2
- **i18n**: next-intl with 8 locales
- **TypeScript**: Full type safety throughout

## Pricing

| Plan | Price |
|------|-------|
| Pro | ${planPriceSummary('pro')} |
| Business | ${planPriceSummary('business')} |
| Enterprise | From ${usd(PLAN_PRICES.enterprise)}/mo, billed annually. Contact team@playbookmedia.io |

There is no free plan. A signed-in workspace is required on every plan. The screenshot editor, media and advanced queues are included in every plan, and exports have no watermark. Launch intelligence is in early access for design partners. Details: ${BASE_URL}/pricing

## Privacy

Editing and preview rendering happen in the browser, and imported images are not uploaded merely to edit them. Account and workspace operations use server-side tenant data. Export compression, URL capture, tweet import, and remote-image import send the data needed for those operations to the server or named providers. Authentication uses session cookies, configured analytics may use identifiers, and public pages may load Google AdSense. See ${BASE_URL}/privacy-policy for details.

## Use Cases

1. **Release Launches**: Turn a release into a cited launch brief, on-brand visuals, and posts that a person approves before they ship
2. **Social Media Graphics**: Create images for Twitter/X, Instagram, LinkedIn, and Product Hunt launches
3. **SaaS Screenshots**: Style product screenshots for landing pages, documentation, and app stores
4. **Developer Portfolios**: Show projects with framed screenshots
5. **Marketing Materials**: Create graphics for presentations, pitch decks, and ads
6. **Documentation**: Add framed screenshots to docs and READMEs
7. **Animated Content**: Create animated slideshows and export as video

## Contact & Links

- **Website**: ${BASE_URL}
- **Email**: team@playbookmedia.io
- **Bug Reports and Feature Requests**: team@playbookmedia.io
`;
