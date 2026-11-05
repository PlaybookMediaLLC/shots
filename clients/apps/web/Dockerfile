# syntax=docker/dockerfile:1.7
FROM node:22.23.4-bookworm-slim AS base

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
    && apt-get install --no-install-recommends --yes openssl \
    && rm -rf /var/lib/apt/lists/*

# Build from the repository root:
#   docker build --file clients/apps/web/Dockerfile .
FROM base AS dependencies

WORKDIR /app/clients

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
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline --no-audit

FROM dependencies AS builder

WORKDIR /app

COPY clients ./clients
COPY server/internal/medialimits/limits.json ./server/internal/medialimits/limits.json

WORKDIR /app/clients/apps/web

# Public values are compiled into the browser bundle. Do not pass secrets here.
ARG NEXT_PUBLIC_POSTHOG_HOST
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_R2_PUBLIC_URL
ARG NEXT_DEPLOYMENT_ID

ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST \
    NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY \
    NEXT_PUBLIC_R2_PUBLIC_URL=$NEXT_PUBLIC_R2_PUBLIC_URL \
    NEXT_DEPLOYMENT_ID=$NEXT_DEPLOYMENT_ID

# The editor bundle exceeds Node's default 2 GiB heap on some build hosts.
# Compiler caches stay on the builder instead of inflating exported image layers.
RUN --mount=type=cache,target=/app/clients/apps/web/.next/cache \
    NODE_OPTIONS=--max-old-space-size=4096 npm run build

# Public images are versioned in R2; fonts and other runtime files stay bundled.
# Keep local files only for self-contained builds without R2.
RUN if [ -n "$NEXT_PUBLIC_R2_PUBLIC_URL" ]; then \
      node -e 'const fs=require("fs"); for(const root of ["public",".next/standalone/clients/apps/web/public"]) for(const p of Object.keys(require("./lib/assets/public-images.json"))) fs.rmSync(root+p,{force:true})'; \
    fi

FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# The standalone output mirrors the repository layout from its tracing root.
COPY --from=builder --chown=nextjs:nodejs /app/clients/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/clients/apps/web/public ./clients/apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/clients/apps/web/.next/static ./clients/apps/web/.next/static

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "clients/apps/web/server.js"]
