import { BASE_URL } from '@/lib/agents/site-content'
import { apiKeyScopeDescriptions, apiKeyScopes } from '@/lib/auth/api-key-scopes'

const scopeRows = apiKeyScopes
  .map((scope) => `| \`${scope}\` | ${apiKeyScopeDescriptions[scope]} |`)
  .join('\n')

/**
 * The reference's introduction: a quickstart, authentication, plans and
 * limits, idempotency, and errors. It is the OpenAPI `info.description`, so
 * Scalar renders it above the operations and machines read it from
 * `/openapi.json`; there is no second document.
 */
export const apiGuide = `Shots turns a software release into a reviewed launch: a cited brief, on-brand visuals, and channel posts that a person approves before anything is scheduled. This API exposes the same workspace operations the app uses.

## Quickstart

1. Create a workspace API key in **Settings → Developer API** (\`${BASE_URL}/settings/developers\`). Give it only the scopes it needs. The key is shown once.
2. Send it in the \`X-API-Key\` header:

\`\`\`bash
export SHOTS_API_KEY="ss_..."
curl ${BASE_URL}/api/v1/releases -H "X-API-Key: $SHOTS_API_KEY"
\`\`\`

3. Create a draft campaign. Every post starts as a draft; nothing is scheduled until a person approves it:

\`\`\`bash
curl -X POST ${BASE_URL}/api/v1/campaigns \\
  -H "X-API-Key: $SHOTS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: recurring-invoices-launch" \\
  -d '{"name":"Recurring invoices","objective":"Announce recurring invoices","posts":[{"channel":"linkedin","copy":"Recurring invoices are here."}]}'
\`\`\`

4. Submit the drafts for review with \`POST /api/v1/campaigns/{campaignId}/review-requests\`. Approvers decide in the app.

### Typed TypeScript client

The document is OpenAPI 3.1. Generate types from it and call the API with full request and response typing:

\`\`\`bash
npx openapi-typescript ${BASE_URL}/openapi.json -o shots.d.ts
npm install openapi-fetch
\`\`\`

\`\`\`ts
import createClient from 'openapi-fetch'
import type { paths } from './shots'

const shots = createClient<paths>({
  baseUrl: '${BASE_URL}',
  headers: { 'X-API-Key': process.env.SHOTS_API_KEY! },
})
const { data, error } = await shots.GET('/api/v1/campaigns/{campaignId}', {
  params: { path: { campaignId: 'c...' } },
})
\`\`\`

## Authentication

| Credential | How to send it | For |
| --- | --- | --- |
| Workspace API key | \`X-API-Key: ss_...\` | Scripts, CI, and agents. A key belongs to one workspace and carries scopes. |
| Signed-in session | The \`better-auth.session_token\` cookie | Same-origin browser calls, checked against the member's role. |

Each operation lists the scope it needs in its security requirement. A key can never choose another workspace: the workspace is the key's own.

| Scope | Allows |
| --- | --- |
${scopeRows}

Approving, rejecting, or requesting changes on posts is a person's decision and takes a session only. Those operations refuse API keys with \`403\`, whatever the key's scopes.

A key with \`post:schedule\` may schedule campaign posts and visuals a person approved, and cancel scheduled posts. Nothing unapproved can be scheduled, by a key or a person. A session that schedules a variant or cancels a post needs a sign-in under 15 minutes old with two-factor enabled.

Shell operations (\`/api/v1/me\`, \`/api/v1/bootstrap\`, \`/api/v1/organizations\`) describe the signed-in user and refuse API keys.

## Plans and limits

There is no free plan: every operation here needs a Pro, Business or Enterprise subscription, and a workspace without one can only sign in and choose a plan. Each gated operation publishes its gate in \`x-shots-entitlement\`: the \`feature\` it needs, the \`minimumPlan\` that includes it, and the \`quota\` it consumes.

- A workspace without the feature gets \`403\` with code \`workspace_feature_not_entitled\`, plus \`feature\`, \`currentPlan\`, and \`requiredPlan\`.
- A metered write past its quota gets \`429\` with code \`workspace_quota_exceeded\`, plus \`Retry-After\` and \`X-RateLimit-*\` headers.
- Each API key is also limited to 60 requests per minute.

## Idempotency

Creating a release, campaign, or scheduled post accepts an \`Idempotency-Key\` header of up to 128 characters. A retry with the same key returns the original result with \`200\` instead of creating a duplicate. Status changes (campaign transitions, review requests, approvals, cancellations) apply only from the current status, so a repeated request returns \`409\` and changes nothing.

## Errors

Every failure returns one JSON envelope with a stable \`code\`, a human-readable \`message\`, and a \`hint\`. Branch on \`code\`; it is stable within \`v1\`. Every response carries \`X-Request-Id\`; send your own to correlate logs.`
