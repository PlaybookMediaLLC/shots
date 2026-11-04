# Code Studio

**Status:** Phases 0–2 implemented, Phase 3 in progress (2026-11-04)
**Authorization:** owner-approved product line; see the
[RFC index](rfcs/README.md) scoped authorization of 2026-11-04.

Code Studio turns code into content: a snippet, a diff, a pull request or a
scripted terminal session becomes an image, a carousel or a short video, and
"Post this" opens it as a Publish draft. It is not an IDE: nothing runs,
lints or edits beyond what a post needs.

Developers already have code-image tools (Carbon, ray.so, CodeImage, Chalk.ist,
Snappify, Hackreels). None takes the result to a scheduled post. Shots already
publishes to X, LinkedIn and TikTok and has brand kits, campaigns and
automation; Code Studio connects code visuals to them.

## Where it lives

| Surface | Route or file |
| --- | --- |
| Studio | `/create/code` (new, kept in this browser) and `/create/code/{projectId}` (saved) |
| Library | Library › Code (`/library?type=code`) |
| Old tool | `/code` redirects to `/create/code`; an old `#…` link opens as a new project |
| Renderer | `components/code-studio/CodeScene.tsx`, a Shiki-based scene used by the editor, every export, the server render and embeds |
| Document | `lib/code-studio/document.ts` (`codeDocumentSchema`, version 1) |
| Storage | a creative set of kind `code` (`platform_creative_set`, migration `20261104090000_platform_code_projects.sql`) |

A code project reuses the creative-set lifecycle: revision-checked autosave,
conflict merge, local recovery, duplicate and archive. The backend bounds the
document (1 MB, 50 slides, 2 panes, 10 files per pane, 100,000 characters per
file) and never reads code text as asset references. A project's footer logo
is its only asset, and the backend checks that it belongs to the workspace.

## What shipped

### Phase 0: in the app

- The studio inside the app shell, with themed controls (the old tool's
  invisible selected states and white menus came from dark-only upstream
  styles under a light theme).
- Save to the workspace; Library › Code with search and language and
  repository filters.
- Brand themes: each brand kit becomes a theme. Brand colors color keywords,
  functions and strings only where they keep a 3:1 contrast on the window;
  the theme is stored as a frozen copy, so archiving a kit never breaks a save.
- Size presets: fit, X 16:9, LinkedIn 1.91:1, square, 4:5 and 9:16. Sizes are
  arithmetic (monospace, fixed line height, no wrapping), so every export and
  frame matches the editor.
- Post this: the PNG is saved as a workspace export with the code as alt text
  (at most 1,000 characters, the asset limit), then a Publish draft opens with
  it attached and, optionally, the code as a reply. Any failure stops before a
  draft exists.

### Phase 1: static content

- Shiki highlighting with a CSS-variables theme, so the 14 ray.so palettes
  and brand palettes are variables; 40 languages, detected from the file name
  or guessed with highlight.js.
- File tabs with icons, split panes, line highlight, focus and blur (for
  hiding secrets), numbered markers and callouts.
- Diffs (unified or side by side) from a file's earlier code.
- Editor, terminal, card and bare frames, and an attribution footer.
- Slides exported as a PNG ZIP or a PDF for LinkedIn carousels; Post this can
  attach every slide.
- Import from a GitHub file permalink (with a line range), a pull request, a
  commit or a gist, or open a local file.

### Phase 2: animated code

Each slide is a video step with a transition (token morph, typing, crossfade
or cut), a transition length, a hold and a caption. `lib/code-studio/timeline.ts`
is a pure function of time, so the preview and every exported frame match.
Morphs use Shiki Magic Move's keyed tokens. Video renders in the browser with
the existing WebCodecs encoder (MP4, WebM, with alpha where the browser
supports VP9 alpha) or FFmpeg (GIF), at 720p, 1080p or 4K where supported,
with an optional voice-over. Post this can attach the MP4.

### Phase 3: automation and reach (so far)

- Terminal scripts: VHS `.tape` commands (Type, Enter, Sleep, Backspace,
  Ctrl+L, Ctrl+C, Hide, Show, Set TypingSpeed) plus one Shots command,
  `Print "…"`, for output. Nothing runs, so recordings are safe and
  deterministic.
- Write caption: an AI caption from the slide's code, charged to AI credits,
  with the code fenced as untrusted data.
- Public API: `POST /api/v1/code-projects`, `GET /api/v1/code-projects/{projectId}`
  and `POST /api/v1/code-projects/{projectId}/render` (a server-side PNG
  through the headless renderer). The MCP server exposes them as tools.
- Embeds: a share link can carry a frozen copy of one slide. Its embed page
  shows the code as real, selectable text with a Copy button, and embed
  routes may be framed by other sites.
- Campaigns › Visuals › Code highlights lists the release's pull requests and
  commits. Each opens Code Studio with the link ready to import (nothing is
  read until the member imports it), and Export › Add image to campaign
  links the image as a `code-visual` for review with the other visuals.
- `shots code file.ts --lines 10-20 [--png out.png] [--open]`
  (`clients/integrations/cli`) and a VS Code extension, "Shots: Send
  selection to Shots" (`clients/integrations/vscode`). Both call the public
  API with a workspace API key; the extension keeps the key in VS Code's
  secret storage.

## Source-code policy

Shots reads source code only when a person explicitly asks:

1. **Member imports.** Pasting a GitHub link reads that file, pull request,
   commit or gist with the workspace's GitHub App installation for the
   account, or anonymously for public code. The result goes back to that
   member; nothing is stored until they save a project, and then only in it.
   Importing needs an editing role. The audit log (`product.code_imported`)
   records the repository, link kind and file count, never code.
2. **Release automation stays as RFC 016 describes:** titles, bodies, labels
   and changed paths only. A future Automate action that renders code from a
   diff must be turned on per action by a workflow owner, and it stores code
   only in the code project it creates.

Rendering happens in the browser. A code project leaves the browser only when
it is saved, posted, embedded or rendered through the API.

## Decisions

- Every Code Studio feature, video included, is on every paid plan; no new
  plan feature key.
- Brand fonts are not monospace, so the brand theme takes colors and the logo;
  code stays in a code font.
- Reply posts carry the code text; gist links would need each user's GitHub
  token with the `gist` scope.
- Video renders in the browser only.

## Not built yet

- An Automate action that renders a code visual from a release's diff into a
  campaign.
- A server-side render queue for long or 4K videos. Headless Chromium usually
  lacks an H.264 encoder, so it needs a worker with FFmpeg and render quotas.
- Real command execution for terminal recordings. It needs an isolated
  runtime (gVisor or Firecracker), egress limits and a security review.
- Updating an embed in place; create a new embed and revoke the old link.
- Publishing the CLI to npm and the extension to the Marketplace (credentials).

## Risks

| Risk | Mitigation |
| --- | --- |
| Free tools make static images worthless | Static images stay in every paid plan; the value is saving, brand themes, carousels, video, posting and automation |
| Developers will not paste private code | Rendering in the browser; nothing stored until saved; imports read only on request and are audited without content |
| Video rendering cost | Browser rendering only; no server queue |
| Scope creep into an IDE | No running, linting or editing beyond what a post needs |
| ray.so-derived themes | The MIT notice is in `THIRD_PARTY_NOTICES.md` |

## Success metrics

Analytics events carry counts and enums only, never code:
`code_studio_save`, `code_studio_export` (with the kind), `code_studio_post`,
`code_studio_import`, `code_studio_embed` and `code_project_open`.

| Metric | Target 90 days after Phase 1 |
| --- | --- |
| Code visuals created per active workspace per week | Set after a two-week baseline |
| Share of code visuals sent to Publish with Post this | 40% or more |
| Median time from paste to scheduled post | Under 60 seconds |
| Video exports per week | Tracked from launch |
