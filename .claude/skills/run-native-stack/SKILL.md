---
name: run-native-stack
description: Run the Shots web app and Go backend in a cloud session without Docker images, sign in as the local dev account, and drive or screenshot pages with Playwright. Use when asked to run, start, stand up or screenshot the app, or to confirm a UI change in the real app, where `make up` cannot pull or build its images.
---

# Run the Native Stack

Paths below are relative to the repository root.

`make up` is the normal local stack. In a Claude Code cloud container it does
not work: the Docker daemon is not running, Docker Hub answers image pulls
with 429, and containers cannot reach the network proxy for the npm and Go
downloads their builds need. `dev/native-stack` runs the same services as
host processes, on the ports `dev/compose.yaml` publishes.

## Start

```bash
dev/native-stack up      # Postgres, Redis, Temporal, Go migrations and API, collab, next dev
dev/native-stack login   # dev@localhost.test with a Pro workspace, as make up creates
dev/native-stack status
```

| Service | Address |
| --- | --- |
| Web (`next dev`) | http://localhost:3000 |
| Go product API | http://127.0.0.1:8080, MCP on 3100 |
| Collab server | ws://127.0.0.1:1234 |
| Temporal dev server | 127.0.0.1:7233 |
| Postgres | 127.0.0.1:54329, user `postgres`, trust auth |
| Redis | 127.0.0.1:63799 |

- Logs, binaries and Temporal's database are in `.local/native/`; secrets
  and `STUDIO_DEV_PASSWORD` are in `.local/dev.env`.
- `up` skips services that already answer, so it is safe to rerun.
- Web changes hot-reload. After a Go change, run `down`, then `up`.
- `next dev` compiles each route on its first request; allow minutes.
- Not running: RustFS (uploads and asset storage), the publishing
  orchestrator (scheduled posts) and the render browser. A page that needs
  one fails; report that rather than patching around it.

## Drive and Screenshot

Chromium and Playwright are preinstalled, and `require('playwright')` works
from any directory. Sign in through the context's request client, which
shares cookies with its pages. Run the script with
`STUDIO_DEV_PASSWORD="$(grep '^STUDIO_DEV_PASSWORD=' .local/dev.env | cut -d= -f2-)" node shoot.cjs`:

```js
const { chromium } = require('playwright')
const app = 'http://localhost:3000'
;(async () => {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const res = await context.request.post(`${app}/api/auth/sign-in/email`, {
    data: { email: 'dev@localhost.test', password: process.env.STUDIO_DEV_PASSWORD },
    headers: { origin: app },
  })
  if (!res.ok()) throw new Error(`sign-in ${res.status()}`)
  const page = await context.newPage()
  await page.goto(`${app}/home`, { waitUntil: 'networkidle', timeout: 180_000 })
  await page.screenshot({ path: 'home.png' })
  await browser.close()
})()
```

- Keep scripts and screenshots in the scratchpad, not the repository.
- Look at every screenshot before reporting it: a blank or error page is a
  failed run. Then send the screenshots to the user.
- Back a layout claim, such as alignment or spacing, with numbers from
  `getBoundingClientRect`, not only a picture.
- For a before-and-after comparison of committed work, reverse it on disk
  with `git diff <base> -- <files> | git apply -R`, let the dev server
  reload, capture, restore with `git checkout -- <files>`, and confirm
  `git status` is clean.

## Run an End-to-End Spec

The suite's channels go through its social API mock, so start the backend
pointed at it. Stop only the backend; `up` restarts it and skips the rest:

```bash
kill "$(cat .local/native/backend.pid)"
E2E_SOCIAL_API_URL=http://127.0.0.1:5679/api/public/v1 dev/native-stack up
```

Then run the spec from `clients/apps/web` with the variables `e2e_npm` in
`dev/studio` sets:

```bash
set -a; . ../../../.local/dev.env; set +a
E2E_BASE_URL=http://localhost:3000 E2E_DATABASE_URL="$HOST_DATABASE_URL" \
  E2E_MAINTENANCE_SECRET="$CLEANUP_SECRET" E2E_WEBHOOK_SECRET="$CLEANUP_SECRET" \
  E2E_REDIS_URL=redis://127.0.0.1:63799 E2E_COMPOSE_LOGS=false \
  npx playwright test test/e2e/<file>.spec.ts
```

`next dev` serves both Playwright projects. A test that needs a service
listed as not running fails here; run it with `make e2e` where Docker works.

## Stop

```bash
dev/native-stack down
```

Data stays in Postgres and `.local/native/` for the next `up`. Stop
processes by PID or with `down`; `pkill -f` matches the shell that runs it.
