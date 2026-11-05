# syntax=docker/dockerfile:1.7
# The collaboration server (RFC 013). Build from the repository root:
#   docker build --file clients/apps/collab-server/Dockerfile .
FROM node:22.23.4-bookworm-slim AS dependencies

WORKDIR /app

COPY clients/package.json clients/package-lock.json ./
# npm ci links every workspace, so each workspace manifest must exist first.
# test/workspace-manifests.test.ts fails when a workspace is missing here.
COPY clients/apps/collab-server/package.json ./apps/collab-server/
COPY clients/apps/web/package.json ./apps/web/
COPY clients/packages/platejs-editor/package.json ./packages/platejs-editor/
COPY clients/packages/screenshot-studio-backend-sdk/package.json ./packages/screenshot-studio-backend-sdk/
COPY clients/packages/shots-api-client/package.json ./packages/shots-api-client/
COPY clients/packages/access-control/package.json ./packages/access-control/
COPY clients/packages/audit-logs/package.json ./packages/audit-logs/
COPY clients/packages/sso/package.json ./packages/sso/
COPY clients/packages/whitelabeling/package.json ./packages/whitelabeling/
RUN --mount=type=cache,target=/root/.npm npm ci --workspace @shots/collab-server --omit=dev --ignore-scripts --no-audit

FROM node:22.23.4-bookworm-slim

ENV NODE_ENV=production \
    PORT=1234

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY clients/apps/collab-server/package.json ./package.json
COPY clients/apps/collab-server/src ./src

USER node

EXPOSE 1234

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 1234) + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

# Node 22 runs the TypeScript source directly (type stripping); there is no build step.
CMD ["node", "src/main.ts"]
