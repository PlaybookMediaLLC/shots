# Screenshot Studio backend SDK

Typed TypeScript client for the Go backend's APIs: workspaces, assets,
designs, projects, presets, brand kits, share links, integrations, publishing,
and social OAuth. Build with `npm run build` in this directory. The package
exports JavaScript and type declarations from `dist`; `npm pack --dry-run`
verifies the release artifact.

The app compiles this package from source: `tsconfig.json` maps
`screenshot-studio-backend-sdk` to `src/index.ts`, so a backend endpoint and its
client ship in one pull request. The Next.js server reaches it through
`lib/backend/sdk.ts`; UI calls remain on same-origin tRPC routes.

Instantiate only in a trusted server process. The client sends a private
`PUBLISHING_SERVICE_TOKEN` and the current session ID. The Go API validates
that session and its workspace role from the shared database before each
operation. Never put the service token in browser code or `NEXT_PUBLIC_*` env.

Scheduled post status includes `UNKNOWN_DELIVERY`, which requires remote
reconciliation before any retry.

## Releasing

CI publishes the package; nobody runs `npm publish`. Bump `version` in this
`package.json` in the pull request that changes the SDK. The Publish SDK
workflow (`.github/workflows/publish-sdk.yml`) fails a pull request that
changes the SDK without a new version, and publishes the new version when the
change reaches `main`, for consumers outside this repository. The app itself
uses the source, so it needs no reinstall.

The workflow authenticates with npm trusted publishing, and only from `main`:
its publish job runs in the `npm` GitHub environment, which deploys from
`main` alone, and npm trusts only that environment. On npmjs.com, the
package's trusted publisher is GitHub Actions,
`PlaybookMediaLLC/shots`, workflow `publish-sdk.yml`, environment
`npm`. Do not add an npm token as a repository secret: any branch could read it.
