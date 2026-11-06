import { TerminalIcon as CommandLineIcon } from '@phosphor-icons/react/dist/ssr/Terminal'
import { PencilSimpleIcon as Edit02Icon } from '@phosphor-icons/react/dist/ssr/PencilSimple'
import { WebhooksLogoIcon as WebhookIcon } from '@phosphor-icons/react/dist/ssr/WebhooksLogo'
import { apiErrorBody } from '@/lib/api/errors'
import { apiKeyScopes, type ApiKeyScope } from '@/lib/auth/api-key-scopes'
import { workspacePlanSchema } from '@/lib/billing/plans'
import { cn } from '@/lib/utils'
import { CodeTabs } from '../CodeTabs'
import { FaqBlock, LinkCards, MarketingShell, PageHero, RowTable, TileGrid } from '../blocks'
import { MONO, MUTED, Section, SectionIntro, Stage, Window } from '../primitives'
import { formatQuota } from '../pricing'
import { ReleaseIntakeFlow } from '../diagrams/ReleaseIntakeFlow'

const SCOPE_NOTES: Record<ApiKeyScope, string> = {
  'release:create': 'Create releases, the input to every launch.',
  'source:write': 'Register source apps that send signed webhooks.',
  'asset:write': 'Create and complete workspace assets.',
  'upload:sign': 'Request signed upload URLs for asset bytes.',
  'draft:comment': 'Comment on workspace drafts without approving or publishing.',
  'draft:write': 'Create, update, and delete content drafts.',
  'artifact:read': 'Read releases, assets, and generated artifacts.',
  'onboarding:run': 'Read a product site into its profile and follow the run.',
  'post:publish': 'Write and publish new posts directly. Off unless someone ticks it.',
  'post:schedule': 'Schedule approved campaign posts. People still approve.',
  'queue:write': 'Change future queue slots without moving or publishing posts.',
}

/** Field limits match releaseCreateSchema in lib/tenant/schemas.ts. */
const FIELDS = [
  ['title', 'Required. Up to 160 characters.'],
  [
    'benefitStatement',
    'Why it matters, up to 500 characters. Optional when a source link is given.',
  ],
  ['description', 'What changed, in plain text. Up to 10,000 characters.'],
  ['audience', 'Who should hear about it. Up to 1,000 characters.'],
  ['sourceUrls', 'Up to 20 public http(s) links: the pull request, changelog, and docs.'],
  ['productSurfaceId', 'Optional. The product page this release changes.'],
] as const

const ENDPOINTS = [
  ['POST', '/api/v1/releases', 'release:create', 'Create a release. Accepts Idempotency-Key.'],
  ['GET', '/api/v1/releases', 'artifact:read', 'List workspace releases.'],
  ['POST', '/api/v1/source-apps', 'source:write', 'Register a source app for webhooks.'],
  [
    'POST',
    '/api/v1/assets/upload-url',
    'upload:sign',
    'Reserve an asset and get a write-once upload URL.',
  ],
  ['POST', '/api/v1/assets/{assetId}/complete', 'asset:write', 'Mark an upload complete.'],
  [
    'GET',
    '/api/v1/assets/{assetId}/download-url',
    'artifact:read',
    'Get a short-lived download URL.',
  ],
  [
    'DELETE',
    '/api/v1/assets/{assetId}',
    'asset:write',
    'Queue deletion of an unused asset. Pro and up.',
  ],
] as const

const WEBHOOKS = [
  ['GitHub', 'X-Hub-Signature-256', 'X-GitHub-Delivery'],
  ['GitLab', 'webhook-signature', 'webhook-timestamp'],
  ['Any pipeline', 'X-Shots-Signature', 'X-Shots-Timestamp, -Event-Id'],
] as const

/** A real error body, built by the same function every route uses. */
const ERROR_EXAMPLE = JSON.stringify(
  apiErrorBody(
    429,
    'workspace_quota_exceeded',
    'This workspace has used its monthly AI credits.',
    'Wait for the next cycle or move to a larger plan.'
  ),
  null,
  2
)

/** /product/release-intake: the form, the REST API, signed webhooks, keys, and conventions. */
export function ReleaseIntakePage() {
  return (
    <MarketingShell
      finale={{ lead: 'Create an API key', trail: 'and send a release from your next deploy.' }}
    >
      <PageHero
        body="Type a release into the form, send it from CI with an API key, or let GitHub, GitLab, or your own pipeline send it through a signed webhook. Every path creates the same release, ready for launch intelligence."
        eyebrow={{ href: '/product', label: 'Release intake', parent: 'Product' }}
        lead="Get releases into Shots"
        location="release_intake_hero"
        primary={{ href: '/api-reference', label: 'API reference' }}
        secondary={{ href: '/sign-up', label: 'Get an API key' }}
        trail="from wherever you ship."
      >
        <Stage className="px-4 py-12 sm:px-12 sm:py-20" variant={3}>
          <div className="w-full min-w-0 max-w-[760px]">
            <CodeTabs />
          </div>
        </Stage>
      </PageHero>

      <Section>
        <SectionIntro
          body="All three create the same release in your workspace."
          label="Three ways in"
          lead="Pick the path that fits how you ship:"
          trail="the form, the REST API, or a webhook."
        />
        <div className="mt-24 space-y-12">
          <ReleaseIntakeFlow />
          <TileGrid
            items={[
              {
                icon: Edit02Icon,
                title: 'The release form',
                body: 'Name the release, say why it matters, and paste the links. Best when a teammate writes it.',
              },
              {
                icon: CommandLineIcon,
                title: 'The REST API',
                body: 'POST /api/v1/releases with a workspace API key from CI or a deploy script. Retries are safe with an idempotency key.',
              },
              {
                icon: WebhookIcon,
                title: 'Signed webhooks',
                body: 'Point a GitHub or GitLab release webhook at your source app, or sign your own. GitHub and GitLab releases link their release page as a source.',
              },
            ]}
          />
        </div>
      </Section>

      <Section>
        <SectionIntro
          body="A release is what you send, and a launch is built from it. Editing the release later doesn't rewrite launches already built from it."
          label="The release"
          lead="A release has six fields,"
          trail="and two are enough to start."
        />
        <div className="mt-24">
          <RowTable
            caption="Release fields"
            head={['Field', 'Rule']}
            monoLabels
            rows={FIELDS.map(([field, rule]) => ({ label: field, cells: [rule] }))}
          />
        </div>
      </Section>

      <Section>
        <SectionIntro
          body="Signatures are checked over the exact body bytes before anything is parsed. The table shows the header each sender signs with and the one that guards against replays."
          label="Webhooks"
          lead="Unsigned webhooks are refused,"
          trail="and a redelivery never creates a second release."
        />
        <div className="mt-24">
          <RowTable
            caption="Webhook signatures"
            head={['Sender', 'Signature', 'Replay protection']}
            rows={WEBHOOKS.map(([sender, signature, replay]) => ({
              label: sender,
              cells: [signature, replay].map((value) => (
                <span className={cn(MONO, 'text-[13px] text-white/85')} key={value}>
                  {value}
                </span>
              )),
            }))}
          />
        </div>
        <p className={cn('mt-8 max-w-[760px] text-[15px] leading-[1.6]', MUTED)}>
          A release that arrives by webhook or API key has no author on your team. The AI treats its
          text as untrusted and shows it to the reviewer with the sources.
        </p>
      </Section>

      <Section>
        <SectionIntro
          body={`Workspace API keys carry one of ${apiKeyScopes.length} scopes. They are hashed at rest and shown once, and a revoked key stops working on the next request. No key can manage teammates, SSO, SCIM, audit log export, retention, or publishing.`}
          label="API keys"
          lead="API keys can create releases"
          trail="but can't approve or publish."
        />
        <div className="mt-24 grid gap-16 lg:grid-cols-[1fr_1.2fr]">
          <RowTable
            caption="API key scopes"
            head={['Scope', 'Allows']}
            monoLabels
            rows={apiKeyScopes.map((scope) => ({ label: scope, cells: [SCOPE_NOTES[scope]] }))}
          />
          <RowTable
            caption="REST endpoints"
            head={['Endpoint', 'Scope', 'Does']}
            monoLabels
            rows={ENDPOINTS.map(([method, path, scope, does]) => ({
              label: (
                <>
                  <span className="text-white/50">{method}</span> {path}
                </>
              ),
              cells: [
                <span className={cn(MONO, 'text-[12px]')} key="scope">
                  {scope}
                </span>,
                does,
              ],
            }))}
          />
        </div>
      </Section>

      <Section>
        <SectionIntro
          body="The public OpenAPI spec is generated from the same Zod contracts the routes validate with, and tests keep the two in sync."
          label="Conventions"
          lead="The API follows the same rules everywhere:"
          trail="safe retries, request IDs, and one error format."
        />
        <div className="mt-24 grid gap-4 lg:grid-cols-2">
          <TileGrid
            columns={2}
            items={[
              {
                snippet: 'Idempotency-Key',
                title: 'Safe retries',
                body: 'Up to 128 characters. Longer keys are rejected, not cut short. A replay returns 200 with the first result.',
              },
              {
                snippet: 'X-Request-Id',
                title: 'Traceable',
                body: 'Every response carries a request ID that also appears in the audit log.',
              },
              {
                snippet: '/openapi.json',
                title: 'OpenAPI 3.1',
                body: 'Also at /.well-known/openapi.json, with an interactive reference at /api-reference.',
              },
              {
                snippet: 'Accept: text/markdown',
                title: 'Readable by AI tools',
                body: 'llms.txt, llms-full.txt, and Markdown versions of supported pages.',
              },
            ]}
          />
          <Window className="min-w-0" meta="lib/api/errors.ts" title="One error envelope">
            <pre
              className={cn(
                MONO,
                'overflow-x-auto p-5 text-[12.5px] leading-[1.7] text-emerald-200/80'
              )}
            >
              {ERROR_EXAMPLE}
            </pre>
          </Window>
        </div>
      </Section>

      <Section>
        <SectionIntro
          body="API writes are limited per workspace by plan. Reads are not counted."
          label="Rate limits"
          lead="API write limits"
          trail="for each plan."
        />
        <div className="mt-24">
          <RowTable
            caption="API write limits"
            head={['Plan', 'API writes per minute', 'AI credits per month']}
            rows={workspacePlanSchema.options.map((plan) => ({
              label: plan[0].toUpperCase() + plan.slice(1),
              cells: [
                <span className={cn(MONO, 'text-[13px] text-white')} key="api">
                  {formatQuota(plan, 'api:write:minute')}
                </span>,
                <span className={cn(MONO, 'text-[13px] text-white')} key="gen">
                  {formatQuota(plan, 'ai:credits:monthly')}
                </span>,
              ],
            }))}
          />
        </div>
      </Section>

      <FaqBlock
        items={[
          {
            q: 'Is there an SDK?',
            a: 'Not yet. The API is plain REST with an OpenAPI 3.1 spec, so any generated client works.',
          },
          {
            q: 'Does the API send webhooks back to me?',
            a: 'Not yet. Outbound release and delivery events are planned. Today, poll the release list or watch the workspace.',
          },
          {
            q: 'Can the API create launches or approve posts?',
            a: 'Launch endpoints are planned. An API key will never be able to approve.',
          },
          {
            q: 'Is there a GitHub App?',
            a: 'Yes. Connect a repository, and merges are held for the next published release, which arrives with its notes and linked pull requests. A repository webhook pointed at your source app also works.',
          },
        ]}
      />

      <Section>
        <SectionIntro
          label="Related"
          lead="See every integration,"
          trail="what the AI does with a release, and Shots for developer tools."
        />
        <div className="mt-24">
          <LinkCards
            paths={['/integrations', '/product/launch-intelligence', '/solutions/developer-tools']}
          />
        </div>
      </Section>
    </MarketingShell>
  )
}
