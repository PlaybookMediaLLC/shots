# Upstream: oppulence-canvas `packages/platejs-editor`

This package is a vendored copy, decided in
[RFC 013](../../../docs/rfcs/013-workspaces-and-content-drafts.md).

| | |
| --- | --- |
| Source repository | `git@github.com:Oppulence-Engineering/oppulence-canvas.git` |
| Source path | `packages/platejs-editor` |
| Source package | `@canvas/platejs-editor` 1.1.0 (private) |
| Vendored commit | `22920383d908a170c1af6a6d84a363ed5cc16f12` (2026-09-11) |
| Vendored on | 2026-10-17 |
| Package here | `@shots/platejs-editor` |

## Ownership and license

PlaybookMediaLLC has confirmed the right to copy this code from
Oppulence-Engineering into this repository (2026-10-17). From this copy on it
is distributed under this repository's license (Apache-2.0, see `LICENSE` at
the repository root).

Many UI components started from the [Plate](https://platejs.org) registry,
which is MIT licensed (Copyright (c) Ziad Beyens, Dylan Schiemann, Joe Anderson,
Felix Feng).

## What was copied

Every tracked file under `packages/platejs-editor` at the vendored commit, via
`git archive`. Not copied: `tsconfig.tsbuildinfo`, `node_modules`, `.turbo`.

## Local changes

Keep this list current. It is what a later pull has to re-apply.

Build and tooling (this repository has no Bun, Turbo or Biome):

- `package.json`: renamed to `@shots/platejs-editor`; the 27 subpath exports
  are unchanged. Scripts run `tsx --test` and `tsc`. `@canvas/tsconfig`,
  `@types/node`, `typescript` and the Biome scripts are gone (the root
  provides TypeScript and types). React is a `^19.2.5` peer; the app is on
  19.2.5, so one copy installs.
- `package.json` dependencies:
  - shared with the app (`ai`, `zod`, `lucide-react`, `tailwind-merge`,
    `sonner`, `date-fns`, `clsx`, `class-variance-authority`, `react-tweet`
    and the Radix packages) use the app's ranges, so npm resolves one copy;
  - `platejs` and `@platejs/test-utils` are pinned to 53.3.15, so `platejs`,
    `@platejs/core`, `@platejs/slate` and `@platejs/utils` resolve to one
    version (the other `@platejs/*` packages keep their upstream exact pins);
  - removed because nothing in `src` imports them: `@platejs/autoformat`,
    `@radix-ui/react-scroll-area`, `@radix-ui/react-select`,
    `@radix-ui/react-toggle-group`, `@radix-ui/react-visually-hidden`,
    `emoji-picker-react`, `is-hotkey`, `jotai`, `jotai-x`, `react-colorful`,
    `scroll-into-view-if-needed`;
  - `jsdom` added as a dev dependency (the DOCX test needs it; upstream got it
    hoisted from elsewhere in its monorepo).
- `tsconfig.json`: extends the root `tsconfig.json` (strict) instead of
  `@canvas/tsconfig`; no `bun-types`; `paths` is empty, so an `@/` import
  fails to type-check.
- Tests: the nine `bun:test` and `vitest` files import
  `test/bun-test-compat.ts`, a small `node:test` shim with the same API, so
  each test changed only its import line. `test/setup.ts` and
  `test/esm-hooks.mjs` give Node what Bun provided: empty CSS imports, named
  `lodash` imports, and `mammoth` resolved to its browser bundle (which
  `src/plugins/docx-io.test.ts` used to mock; that test lost the mock lines).
- Lint and format: Biome is replaced by the repository's ESLint, with a scoped
  block in `eslint.config.mjs` that turns off the rules Plate's conventions
  trip, and a package `.prettierrc.json` matching the upstream style.
  Upstream files are not reformatted; Prettier checks only `test/`.

Boundaries (RFC 013: the package reaches nothing the app owns, enforced by
`test/editor-package-boundary.test.ts`):

- `src/lib/editor-services.tsx` (new): `EditorServicesProvider` injects the
  host's `uploadFile` and AI endpoints.
- `src/hooks/use-upload-file.ts`: rewritten around the injected `uploadFile`.
  uploadthing is gone (`src/lib/uploadthing.ts` and the `OurFileRouter` type
  export are deleted), and a failed upload rejects instead of falling back to
  a mock object URL.
- `src/ui/media-placeholder-node.tsx`: keeps the host's `assetId`, MIME type and ready state on the
  uploaded media node so the host can distinguish GIFs and videos without URL guesses.
- `src/components/use-chat.ts`: the chat endpoint comes from `ai.chat`; with
  none, a send fails visibly instead of posting to `/api/ai/command`. The
  system template names Shots instead of Eigenn.
- `src/plugins/copilot-kit.tsx`: the completion endpoint comes from
  `ai.copilot`; with none, no completion is requested (was `/api/ai/copilot`).
- `src/collaboration/index.ts`: `assertPrivateSignaling` refuses a WebRTC
  configuration without explicit signaling servers, or with the public
  y-webrtc ones.
- `src/lib/rehost-images.ts` (new): re-uploads `data:` and `blob:` images, as
  DOCX import produces, through `uploadFile`.
- `src/ui/remote-cursor-overlay.tsx` (new, after the Plate registry's): other
  people's carets and selections; `createYjsPlugin` renders it after the
  editable. Adds the `@slate-yjs/react` dependency.

Post editor (the Write brief: one look with the app, a social slash menu):

- `src/ui/inline-combobox.tsx`: one highlight (hover moves the active row,
  `focusOnHover`, and no separate hover style); Tab runs the active row as
  Enter does; `closeOnSpace` (`empty`: a space right after the trigger types
  it as text; `always`: a space ends the query); the host's `onKeyDown` is
  composed with Plate's instead of replacing it; the popover sits 8px below
  the caret's line (`gutter`) with no extra margin.
- `src/ui/slash-node.tsx`, `src/ui/floating-toolbar-buttons.tsx`,
  `src/ui/block-menu.tsx`: the multicolor 512-viewBox AI mark (three copies
  sharing one gradient id) is Phosphor's `Sparkle` in `text-primary`.

## Pulling a later fix from oppulence-canvas

1. In oppulence-canvas:
   `git diff 22920383d908a170c1af6a6d84a363ed5cc16f12..<new commit> -- packages/platejs-editor > /tmp/editor.patch`
2. Here: `git apply --3way -p3 --directory=packages/platejs-editor /tmp/editor.patch`
3. Resolve conflicts against the local changes above. A new `bun:test` file
   needs only its import pointed at `test/bun-test-compat.ts`.
4. `npm install`, then `npm test -w @shots/platejs-editor` and
   `npm run quality:check`.
5. Update the vendored commit in the table above, in the same change.

## Accepted `npm audit` findings

Recorded 2026-10-17. These are the findings the package adds over the app's
baseline, with `--omit=dev` (uploadthing's, which the vendored copy also
added, left with the upload adapter):

| Package | Severity | Path | Why accepted |
| --- | --- | --- | --- |
| `katex`, `remark-math`, `micromark-extension-math` | low | `@platejs/math`, `remark-math` | Needs existing prototype pollution to matter; `@platejs/math` pins KaTeX 0.16.22. Revisit when Plate moves |
| `xmlbuilder2` → `js-yaml` 3 | high | `@platejs/docx-io` export | `js-yaml` parses YAML input only; DOCX export builds XML and never passes YAML |
| `mammoth` → `argparse` → `sprintf-js` | moderate | `@platejs/docx-io` import | `argparse` serves mammoth's command line, which the browser bundle does not include |

`jotai` installs twice (2.8.4 for `@platejs/core`, 2.20.3 for
`@platejs/toggle`) because Plate's own packages require incompatible ranges.
