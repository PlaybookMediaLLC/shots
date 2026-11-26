# Test the AI features without tokens

[emulate](https://github.com/vercel-labs/emulate) answers the model requests with
scripted rules. It does not run a model.

## Automated tests

`clients/apps/web/test/assistant-emulate.server.ts` runs the assistant through
the real OpenRouter provider against the emulator. It runs with
`npm run test:server`. It needs no key and no running stack.

It checks streaming, one tool call for each editing surface, a server tool, an
inline image, the privacy preference, permissions, a rate limit and a broken
stream.

## The local app

1. From `clients/`, run `npm run ai:emulate`. Keep it running.
2. In a second terminal, from the repository root, run:

   ```bash
   OPENROUTER_API_KEY=emulated \
   OPENROUTER_BASE_URL=http://host.docker.internal:4014/api/v1 \
   make up
   ```

3. Open a surface and use **Ask AI**. The rules are in `dev/emulate-ai.yaml`.
4. Open `http://localhost:4014` to see each request.
5. Run `make up` without the two variables to use your own key again.

## Limits

- The web app uses `OPENROUTER_BASE_URL` only on a developer machine or the
  browser test stack. The Go backend ignores it when `NODE_ENV=production`.
- The emulator reports no cost, so no AI credits are charged.
- The browser suite still uses the built-in scripted model.
