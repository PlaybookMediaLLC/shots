# Shots CLI

`shots code` turns a file, or part of it, into a Code Studio project and
prints its link. It uses the public API (`POST /api/v1/code-projects`), so
code goes only to your workspace.

```bash
export SHOTS_API_KEY=...   # Workspace settings › API keys: asset:write, artifact:read
npx ./clients/integrations/cli code src/server.ts --lines 10-24 --png server.png --open
```

`--png` renders the first slide on the server (when the deployment has the
headless renderer) and saves it. Run `shots --help` for every option. The
package is not published to npm yet.
