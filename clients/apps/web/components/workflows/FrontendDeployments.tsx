'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import {
  frontendSourceInputSchema,
  frontendProviderSchema,
  frontendDecisionSchema,
  githubProductionCatalogSchema,
  type FrontendSource,
  type FrontendSourceInput,
  type FrontendPolicy,
} from 'screenshot-studio-backend-sdk'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'
import { deploymentExample } from '@/lib/workflows/deployment-examples'
import { EmptyState } from '@/components/platform-ui'
import { RocketLaunchIcon } from '@phosphor-icons/react/dist/ssr/RocketLaunch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { getErrorMessage, requestJson } from '@/components/workspace/settings-client'

/** The menu's stand-in for an empty value, which a Select item cannot hold. */
const NONE = '__none'

const providers = {
  github: 'GitHub',
  vercel: 'Vercel',
  netlify: 'Netlify',
  cloudflare_pages: 'Cloudflare Pages',
  cloudflare_workers: 'Cloudflare Workers',
}
/** Where each value comes from, in the words of that host. */
const hostGuides: Record<
  keyof typeof providers,
  {
    account: string
    evidence: string
    help: { href: string; label: string }[]
    project: string
    steps: string[]
  }
> = {
  github: {
    account: '',
    evidence: 'Counts a successful deployment status for your production environment.',
    help: [],
    project: '',
    steps: [
      'Choose the watched repository below.',
      'Save. Shots fills in the rest from your GitHub connection.',
    ],
  },
  vercel: {
    account: 'Team or account ID',
    evidence: 'Counts a signed promotion to production. A build that is only ready does not count.',
    help: [
      { href: 'https://vercel.com/account/tokens', label: 'Create a Vercel token' },
      { href: 'https://vercel.com/docs/webhooks', label: 'Where to find the webhook secret' },
    ],
    project: 'Project ID',
    steps: [
      'Copy the team ID and project ID from their Settings pages in Vercel.',
      'Create a read token, and a webhook for deployment.promoted.',
      'Save here, then point the webhook at the address Shots shows.',
    ],
  },
  netlify: {
    account: 'Team (account) ID',
    evidence: 'Counts the deployment Netlify reports as published. Locked builds do not count.',
    help: [
      {
        href: 'https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/',
        label: 'Create a Netlify token',
      },
      {
        href: 'https://docs.netlify.com/site-deploys/notifications/',
        label: 'Where to set the webhook secret',
      },
    ],
    project: 'Site ID',
    steps: [
      'Copy the site ID from Site configuration in Netlify.',
      'Create a personal access token, and an outgoing deploy webhook with a signing secret.',
      'Save here, then point the webhook at the address Shots shows.',
    ],
  },
  cloudflare_pages: {
    account: 'Cloudflare account ID',
    evidence: 'Counts the deployment serving your project after its final stage succeeds.',
    help: [
      {
        href: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
        label: 'Create a Cloudflare token',
      },
      {
        href: 'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/',
        label: 'Find your account ID',
      },
    ],
    project: 'Pages project name',
    steps: [
      'Copy your account ID and Pages project name from Cloudflare.',
      'Create an API token that can read Pages.',
      'Save here. Shots checks the project on a schedule, with no webhook.',
    ],
  },
  cloudflare_workers: {
    account: 'Cloudflare account ID',
    evidence: 'Counts the Worker version receiving all traffic. Split traffic does not count.',
    help: [
      {
        href: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
        label: 'Create a Cloudflare token',
      },
      {
        href: 'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/',
        label: 'Find your account ID',
      },
    ],
    project: 'Worker script name',
    steps: [
      'Copy your account ID and Worker name from Cloudflare.',
      'Create an API token that can read Workers.',
      'Save here. Shots checks the Worker on a schedule, with no webhook.',
    ],
  },
}
/** What a decision's `checks` value means; each is set by the backend evaluator. */
const checkLabels: Record<string, string> = {
  not_configured: 'none required',
  missing: 'not reported yet',
  passed: 'passed',
}
const initialPolicy: FrontendPolicy = {
  schemaVersion: 1,
  environments: ['production'],
  branch: '',
  tag: '',
  domain: '',
  workflowId: '',
  job: '',
  checks: [],
  alerts: ['matched'],
  workflowVersionId: '',
}
const initial: FrontendSourceInput = {
  githubSourceId: '',
  id: '',
  name: '',
  revision: 0,
  provider: 'vercel',
  accountId: '',
  projectId: '',
  token: '',
  secret: '',
  enabled: false,
  policy: initialPolicy,
}
const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm'
const states = {
  matched: 'Matched',
  not_matched: 'Not a match',
  pending: 'Pending',
  needs_attention: 'Needs attention',
  failed: 'Failed',
}
const healthLabels: Record<string, string> = {
  ready: 'Connected, and Shots can read your host.',
  baseline_pending: 'Waiting for the first poll to establish history without live alerts.',
  promotion_history_requires_webhooks:
    'Vercel promotions require signed webhooks. Its project API cannot reconstruct a missed promotion; check the delivery history in Vercel after an outage.',
  workers_history_bounded:
    'Workers API history is bounded. Builds alone and versions outside that history do not prove production activation.',
  activation_history_gap_review_required:
    'Shots may have missed some promotions or restorations. Check the history on your host.',
  history_gap_page_limit:
    'History exceeded the bounded polling window. Review the gap before relying on this source.',
  github_delivery_history_gap:
    'GitHub delivery history could not cover the gap. Review App deliveries and redeliver missing events.',
  credential_revoked: 'Your host rejected the token. Replace it.',
  permission_missing: 'The token cannot read this project on your host.',
}

/** Marks a field the form cannot save without; `required` tells assistive technology the same. */
function RequiredMark() {
  return (
    <span aria-hidden="true" className="text-destructive">
      {' *'}
    </span>
  )
}

/** Admin configuration and member-readable evidence share the backend evaluator. */
export function FrontendDeployments({ canManage }: { canManage: boolean }) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const params = useSearchParams()
  const [selected, setSelected] = useState(params.get('source') ?? '')
  const [form, setForm] = useState<FrontendSourceInput>(initial)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [scenario, setScenario] = useState('active')
  const [preview, setPreview] = useState<z.infer<typeof frontendDecisionSchema> | null>(null)
  const [connecting, setConnecting] = useState(false)
  const sources = useQuery(
    trpc.frontendDeployments.sources.queryOptions(undefined, { refetchInterval: 30_000 })
  )
  const history = useQuery(
    trpc.frontendDeployments.history.queryOptions(
      { id: selected },
      { enabled: Boolean(selected), refetchInterval: 30_000 }
    )
  )
  const overview = useQuery(trpc.releaseAutomation.overview.queryOptions())
  const update = <K extends keyof FrontendSourceInput>(key: K, value: FrontendSourceInput[K]) => {
    setPreview(null)
    setForm((old) => ({ ...old, [key]: value }))
  }
  const policy = <K extends keyof FrontendPolicy>(key: K, value: FrontendPolicy[K]) => {
    setPreview(null)
    setForm((old) => ({ ...old, policy: { ...old.policy, [key]: value } }))
  }
  const choose = useCallback((source: FrontendSource) => {
    setSelected(source.id)
    setForm(
      frontendSourceInputSchema.parse({
        githubSourceId: source.githubSourceId,
        id: source.id,
        name: source.name,
        provider: source.provider,
        accountId: source.accountId,
        projectId: source.projectId,
        revision: source.revision,
        enabled: source.enabled,
        policy: source.policy,
        token: '',
        secret: '',
      })
    )
    setPreview(null)
  }, [])
  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    setMessage('')
    try {
      await action()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const source = sources.data?.sources.find((item) => item.id === selected)
  useEffect(() => {
    if (source && form.id !== selected) choose(source)
  }, [source, form.id, selected, choose])
  const guide = hostGuides[form.provider]
  const required = (filled: unknown, label: string) => (filled ? [] : [label])
  const missing = [
    ...required(form.name.trim(), 'a name'),
    ...(form.provider === 'github'
      ? required(form.githubSourceId && form.accountId, 'a watched repository')
      : [
          ...required(form.accountId.trim(), guide.account),
          ...required(form.projectId.trim(), guide.project),
        ]),
    ...required(form.revision || form.provider === 'github' || form.token, 'a read token'),
    ...required(
      form.revision || !['vercel', 'netlify'].includes(form.provider) || form.secret,
      'a webhook signing secret'
    ),
    ...required(form.policy.environments.join('').trim(), 'a production environment'),
  ]
  const repositoryId = form.githubSourceId || form.id
  const deploymentWorkflows = (overview.data?.definitions ?? []).filter(
    (d) =>
      d.sourceAppId === repositoryId && d.draft.family === 'deployment.succeeded' && !d.archived
  )
  const activeWorkflows = deploymentWorkflows.filter((d) => d.enabled && d.activeVersionId)
  const problem =
    error ??
    (sources.error
      ? getErrorMessage(sources.error)
      : history.error
        ? getErrorMessage(history.error)
        : null)
  return (
    <div className="space-y-8">
      {problem ? (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      <section aria-label="Connected frontends" className="space-y-3">
        {sources.data?.sources.length ? (
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Connected hosts</h2>
            {canManage ? (
              <Button
                variant="outline"
                onClick={() => {
                  setForm(initial)
                  setSelected('')
                  setPreview(null)
                  setConnecting(true)
                }}
              >
                Connect a host
              </Button>
            ) : null}
          </div>
        ) : null}
        {sources.isPending ? (
          <p>Loading hosts…</p>
        ) : !sources.data?.sources.length && !connecting ? (
          <EmptyState
            action={
              canManage ? <Button onClick={() => setConnecting(true)}>Connect a host</Button> : null
            }
            description={
              <>
                Connect where your site is hosted, such as Vercel, Netlify or Cloudflare. A
                production deployment can then send an alert and start a workflow.{' '}
                <Link className="underline" href="/docs/automate" rel="noopener" target="_blank">
                  Read the guide
                </Link>
              </>
            }
            icon={RocketLaunchIcon}
            title="No hosts connected"
          />
        ) : null}
        {sources.data?.sources.map((item) => (
          <Button
            type="button"
            key={item.id}
            className="flex w-full items-center justify-between rounded-lg border p-4 text-left"
            onClick={() => choose(item)}
            aria-pressed={selected === item.id}
          >
            <span>
              {item.name} · {providers[item.provider]}
            </span>
            <span className="text-sm text-muted-foreground">
              Version {item.revision} · {item.enabled ? 'Alerts enabled' : 'Paused'}
            </span>
          </Button>
        ))}
      </section>
      {source ? (
        <section aria-label="Connection health" className="rounded-lg border p-4 text-sm space-y-2">
          <p>{healthLabels[source.health] ?? `Connection requires review: ${source.health}`}</p>
          <p>
            Initial baseline: {new Date(source.baselineAt).toLocaleString()}. Last successful poll:{' '}
            {source.lastPollAt ? new Date(source.lastPollAt).toLocaleString() : 'Not yet completed'}
            .
          </p>
          {(source.provider === 'vercel' || source.provider === 'netlify') && canManage ? (
            <p>
              Webhook endpoint: <code>/api/webhooks/frontends/{source.id}</code>. Configure this
              path on your Shots domain with the same signing secret.
            </p>
          ) : null}
        </section>
      ) : null}
      {canManage && (source || connecting) ? (
        <form
          className="space-y-5 rounded-lg border p-5"
          onSubmit={(event) => {
            event.preventDefault()
            void perform(async () => {
              const saved = await client.frontendDeployments.save.mutate(
                frontendSourceInputSchema.parse(form)
              )
              choose(saved)
              await sources.refetch()
              setMessage('Production policy saved. Historical events will not be replayed.')
            })
          }}
        >
          <h2 className="font-semibold">
            {form.revision ? 'Edit production policy' : 'Connect a host'}
          </h2>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>{guide.evidence}</p>
            {form.revision ? null : (
              <ol className="list-decimal space-y-1 ps-5">
                {guide.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            )}
            {guide.help.length ? (
              <p className="flex flex-wrap gap-x-4 gap-y-1">
                {guide.help.map((link) => (
                  <a
                    className="underline"
                    href={link.href}
                    key={link.href}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {link.label}
                  </a>
                ))}
              </p>
            ) : null}
            <p>Fields marked * are required.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="frontend-name">
                Name
                <RequiredMark />
              </Label>
              <Input
                id="frontend-name"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="frontend-provider">Host</Label>
              <Select
                value={form.provider}
                disabled={form.revision > 0}
                onValueChange={(value) => {
                  update('provider', frontendProviderSchema.parse(value))
                  update('id', '')
                  update('githubSourceId', '')
                  update('accountId', '')
                  update('projectId', '')
                }}
              >
                <SelectTrigger id="frontend-provider" className={selectClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(providers).map(([id, label]) => (
                    <SelectItem key={id} value={id}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="frontend-repository">
                Watched repository
                {form.provider === 'github' ? <RequiredMark /> : ' (needed to start a workflow)'}
              </Label>
              <Select
                value={form.githubSourceId || NONE}
                disabled={form.revision > 0}
                onValueChange={(choice) => {
                  const value = choice === NONE ? '' : choice
                  const s = overview.data?.sources.find((s) => s.id === value)
                  update('githubSourceId', value)
                  if (form.provider !== 'github') return
                  update('id', value)
                  update('accountId', '')
                  if (!s) return
                  update('projectId', s.repositoryId)
                  update('name', s.name)
                  void perform(async () => {
                    const { installationId, reason } = await requestJson(
                      `/api/v1/github/sources/${encodeURIComponent(value)}/production-catalog`,
                      githubProductionCatalogSchema
                    )
                    if (!installationId) throw new Error(reason)
                    update('accountId', String(installationId))
                  })
                }}
              >
                <SelectTrigger id="frontend-repository" className={selectClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {overview.data?.sources.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {form.provider !== 'github' ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor="frontend-account">
                    {guide.account}
                    <RequiredMark />
                  </Label>
                  <Input
                    id="frontend-account"
                    value={form.accountId}
                    disabled={form.revision > 0}
                    onChange={(e) => update('accountId', e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="frontend-project">
                    {guide.project}
                    <RequiredMark />
                  </Label>
                  <Input
                    id="frontend-project"
                    value={form.projectId}
                    disabled={form.revision > 0}
                    onChange={(e) => update('projectId', e.target.value)}
                    required
                  />
                </div>
              </>
            ) : null}
            {form.provider !== 'github' ? (
              <div className="space-y-1">
                <Label htmlFor="frontend-token">
                  Read token {form.revision ? '(leave blank to keep it)' : <RequiredMark />}
                </Label>
                <Input
                  id="frontend-token"
                  type="password"
                  autoComplete="new-password"
                  value={form.token}
                  onChange={(e) => update('token', e.target.value)}
                  required={!form.revision}
                />
              </div>
            ) : null}
            {['vercel', 'netlify'].includes(form.provider) ? (
              <div className="space-y-1">
                <Label htmlFor="frontend-secret">
                  Webhook signing secret{' '}
                  {form.revision ? '(leave blank to keep it)' : <RequiredMark />}
                </Label>
                <Input
                  id="frontend-secret"
                  type="password"
                  autoComplete="new-password"
                  value={form.secret}
                  onChange={(e) => update('secret', e.target.value)}
                  required={!form.revision}
                />
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="frontend-environments">
                Production environments (comma separated)
                <RequiredMark />
              </Label>
              <Input
                id="frontend-environments"
                value={form.policy.environments.join(', ')}
                onChange={(e) =>
                  policy(
                    'environments',
                    e.target.value.split(',').map((s) => s.trim())
                  )
                }
                required
              />
            </div>
            {(
              [
                ['branch', 'Required branch'],
                ['tag', 'Required tag'],
                ['domain', 'Required production domain'],
                // Hosts cannot prove these today, so a value here blocks every match; shown only to clear one.
                ['workflowId', 'Required GitHub workflow ID'],
                ['job', 'Required GitHub deployment job'],
              ] as const
            )
              .filter(([key]) => !(key === 'workflowId' || key === 'job') || form.policy[key])
              .map(([key, label]) => (
                <div className="space-y-1" key={key}>
                  <Label htmlFor={`frontend-${key}`}>{label} (optional)</Label>
                  <Input
                    id={`frontend-${key}`}
                    value={form.policy[key]}
                    onChange={(e) => policy(key, e.target.value)}
                  />
                </div>
              ))}
            <div className="space-y-1">
              <Label htmlFor="frontend-workflow">Shots workflow after a match</Label>
              <Select
                value={form.policy.workflowVersionId || NONE}
                onValueChange={(value) => policy('workflowVersionId', value === NONE ? '' : value)}
              >
                <SelectTrigger id="frontend-workflow" className={selectClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Alerts only</SelectItem>
                  {activeWorkflows.map((d) => (
                    <SelectItem key={d.id} value={d.activeVersionId ?? ''}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeWorkflows.length ? null : (
                <p className="text-sm text-muted-foreground">
                  {!overview.data?.sources.length ? (
                    <>
                      <Link className="underline" href="/workflows/sources">
                        Watch a repository
                      </Link>{' '}
                      to start a workflow from a deployment.
                    </>
                  ) : !repositoryId ? (
                    'Choose a watched repository above to list its deployment workflows.'
                  ) : deploymentWorkflows[0] ? (
                    <>
                      {deploymentWorkflows[0].name} is not active yet.{' '}
                      <Link className="underline" href={`/workflows/${deploymentWorkflows[0].id}`}>
                        Activate it
                      </Link>
                      , then choose it here.
                    </>
                  ) : (
                    <>
                      This repository has no deployment workflow yet.{' '}
                      <Link
                        className="underline"
                        href="/workflows/new?template=deployment-marketing"
                      >
                        Start from Deployment-driven marketing
                      </Link>
                      , activate it, then choose it here.
                    </>
                  )}
                </p>
              )}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            A value the host does not report needs your attention instead of matching. Your release,
            pull request, tag and milestone workflows are not affected.
          </p>
          <fieldset className="space-y-3">
            <legend className="font-medium">Required checks</legend>
            {!form.policy.checks.length ? (
              <p className="text-sm text-muted-foreground">
                No additional checks. Success alerts will say only that your host reported a
                production deployment.
              </p>
            ) : null}
            {form.policy.checks.map((check, index) => (
              <div key={index} className="grid gap-3 rounded-md border p-3 md:grid-cols-3">
                <Label className="text-sm">
                  Check source
                  <Select
                    value={check.source}
                    onValueChange={(value) =>
                      policy(
                        'checks',
                        form.policy.checks.map((c, i) =>
                          i === index
                            ? {
                                ...c,
                                source: z
                                  .enum(['github_check', 'github_status', 'vercel_check'])
                                  .parse(value),
                              }
                            : c
                        )
                      )
                    }
                  >
                    <SelectTrigger className={selectClass}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="github_check">GitHub check run</SelectItem>
                      <SelectItem value="github_status">GitHub commit status</SelectItem>
                      <SelectItem value="vercel_check">Vercel deployment check</SelectItem>
                    </SelectContent>
                  </Select>
                </Label>
                <Label className="text-sm">
                  Check name
                  <Input
                    value={check.name}
                    onChange={(e) =>
                      policy(
                        'checks',
                        form.policy.checks.map((c, i) =>
                          i === index ? { ...c, name: e.target.value } : c
                        )
                      )
                    }
                  />
                </Label>
                <Label className="text-sm">
                  App / integration ID
                  <Input
                    value={check.appId}
                    onChange={(e) =>
                      policy(
                        'checks',
                        form.policy.checks.map((c, i) =>
                          i === index ? { ...c, appId: e.target.value } : c
                        )
                      )
                    }
                  />
                </Label>
                <Label className="text-sm">
                  Must match
                  <Select
                    value={check.scope}
                    onValueChange={(value) =>
                      policy(
                        'checks',
                        form.policy.checks.map((c, i) =>
                          i === index
                            ? {
                                ...c,
                                scope: z.enum(['commit', 'deployment']).parse(value),
                              }
                            : c
                        )
                      )
                    }
                  >
                    <SelectTrigger className={selectClass}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="commit">Repository and commit</SelectItem>
                      <SelectItem value="deployment">Deployment ID</SelectItem>
                    </SelectContent>
                  </Select>
                </Label>
                <Label className="text-sm">
                  Maximum check age (seconds)
                  <Input
                    type="number"
                    min={60}
                    max={604800}
                    value={check.maxAgeSeconds}
                    onChange={(e) =>
                      policy(
                        'checks',
                        form.policy.checks.map((c, i) =>
                          i === index ? { ...c, maxAgeSeconds: Number(e.target.value) } : c
                        )
                      )
                    }
                  />
                </Label>
                <Label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={check.passing.includes('neutral')}
                    onCheckedChange={(checked) =>
                      policy(
                        'checks',
                        form.policy.checks.map((c, i) =>
                          i === index
                            ? {
                                ...c,
                                passing: checked === true ? ['success', 'neutral'] : ['success'],
                              }
                            : c
                        )
                      )
                    }
                  />
                  Allow neutral as passing
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    policy(
                      'checks',
                      form.policy.checks.filter((_, i) => i !== index)
                    )
                  }
                >
                  Remove check {index + 1}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              disabled={form.policy.checks.length >= 20}
              onClick={() =>
                policy('checks', [
                  ...form.policy.checks,
                  {
                    source: 'github_check',
                    name: '',
                    appId: '',
                    scope: 'commit',
                    passing: ['success'],
                    maxAgeSeconds: 86400,
                  },
                ])
              }
            >
              Add required check
            </Button>
            <p className="text-sm text-muted-foreground">
              A failed check blocks the match. A missing, stale or skipped one needs your attention.
            </p>
          </fieldset>
          <fieldset className="flex flex-wrap gap-4">
            <legend className="mb-2 font-medium">Alert outcomes</legend>
            {(['matched', 'failed', 'needs_attention', 'rollback'] as const).map((kind) => (
              <Label key={kind} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.policy.alerts.includes(kind)}
                  onCheckedChange={(checked) =>
                    policy(
                      'alerts',
                      checked === true
                        ? [...form.policy.alerts, kind]
                        : form.policy.alerts.filter((x) => x !== kind)
                    )
                  }
                />
                {kind === 'matched'
                  ? 'Successful production activation'
                  : kind === 'rollback'
                    ? 'Rollback activity'
                    : states[kind]}
              </Label>
            ))}
          </fieldset>
          <p className="text-sm text-muted-foreground">
            In-app delivery follows workspace and personal preferences. Enable email or shared Slack
            for these events in notification settings.
          </p>
          <Label className="flex items-center gap-2">
            <Checkbox
              checked={form.enabled}
              onCheckedChange={(checked) => update('enabled', checked === true)}
            />
            Enable alerts and the selected workflow for new events
          </Label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || missing.length > 0}>
              {busy ? 'Saving…' : 'Save production policy'}
            </Button>
            {source ? null : (
              <Button onClick={() => setConnecting(false)} type="button" variant="ghost">
                Cancel
              </Button>
            )}
            {missing.length ? (
              <p className="text-sm text-muted-foreground" role="status">
                Still needed: {missing.join(', ')}.
              </p>
            ) : null}
          </div>
        </form>
      ) : null}
      {source || connecting ? (
        <section aria-label="Policy preview" className="space-y-3 rounded-lg border p-5">
          <h2 className="font-semibold">Preview without sending alerts</h2>
          <p className="text-sm text-muted-foreground">
            Try this policy on an example event. Preview sends nothing and starts no workflow.
          </p>
          <Label className="block text-sm">
            Representative event
            <Select
              value={scenario}
              onValueChange={(value) => {
                setScenario(value)
                setPreview(null)
              }}
            >
              <SelectTrigger className={selectClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Production active, checks pass</SelectItem>
                <SelectItem value="preview">Preview environment</SelectItem>
                <SelectItem value="build">Build ready, publication pending</SelectItem>
                <SelectItem value="workflow">Workflow success without deployment proof</SelectItem>
                <SelectItem value="rollback">Rollback request accepted</SelectItem>
                <SelectItem value="missing-check">Required checks missing</SelectItem>
                <SelectItem value="failed-check">Required check failed</SelectItem>
                <SelectItem value="wrong-revision">Checks belong to another revision</SelectItem>
                {history.data?.items.map((item) => (
                  <SelectItem key={item.id} value={`record:${item.id}`}>
                    Recorded: {item.observation.kind} · {item.observation.deploymentId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const record = history.data?.items.find((item) => `record:${item.id}` === scenario)
                setPreview(
                  await client.frontendDeployments.preview.mutate({
                    policy: form.policy,
                    observation:
                      record?.observation ??
                      deploymentExample(form.provider, scenario, form.policy),
                  })
                )
              })
            }
          >
            Preview policy
          </Button>
          {preview ? (
            <div role="status">
              <strong>{states[preview.state]}</strong>
              <p>{preview.reason}</p>
              <p>Required checks: {checkLabels[preview.checks] ?? preview.checks}</p>
              {source ? null : (
                <p className="text-sm text-muted-foreground">
                  This is an example. Nothing is connected to check yet.
                </p>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
      {selected ? (
        <section aria-label="Deployment evidence" className="space-y-3">
          <h2 className="font-semibold">Deployment evidence</h2>
          <p className="text-sm text-muted-foreground">
            The latest 100 events, with when each happened, arrived and was processed. Past events
            never send alerts.
          </p>
          {history.data?.items.map((item) => (
            <Disclosure key={item.id} className="rounded-lg border p-4">
              <DisclosureTrigger>
                {states[(item.current?.decision ?? item.decision).state]} · {item.observation.kind}{' '}
                · {item.observation.deploymentId || item.observation.runId || 'Check evidence'}{' '}
                {item.historical ? '· Historical' : ''}
              </DisclosureTrigger>
              <DisclosureContent>
                <div className="mt-3 space-y-2 text-sm">
                  <p>{(item.current?.decision ?? item.decision).reason}</p>
                  {item.current ? (
                    <p className="text-muted-foreground">
                      At receipt: {states[item.decision.state]} — {item.decision.reason} Current
                      activation evaluated: {item.current.updatedAt}.
                    </p>
                  ) : null}
                  <p>
                    Policy v{item.policyVersion} · {item.observation.provider} ·{' '}
                    {item.observation.projectId} ·{' '}
                    {item.observation.environment || 'Environment unknown'}
                  </p>
                  <p>
                    Revision: {item.observation.revision || 'Not reported'}. Build:{' '}
                    {item.observation.build || 'Unknown'}. Production:{' '}
                    {item.observation.production || 'Unknown'}. Checks:{' '}
                    {(item.current?.decision ?? item.decision).checks || 'Unknown'}.
                  </p>
                  <p>
                    Occurred: {item.observation.occurredAt}. Received: {item.receivedAt}. Processed:{' '}
                    {item.processedAt}.
                  </p>
                  {item.observation.activationObservedAt ? (
                    <p>Production change observed: {item.observation.activationObservedAt}</p>
                  ) : null}
                  {item.observation.evidence?.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  {item.observation.url.startsWith('https://') ? (
                    <a
                      className="underline"
                      href={item.observation.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open this deployment on your host
                    </a>
                  ) : null}
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-3">
                    {JSON.stringify(
                      {
                        checks: (item.current?.observation ?? item.observation).checks,
                        policy: item.policy,
                        providerEventId: item.observation.providerEventId,
                        activationId: item.observation.activationId,
                        runId: item.observation.runId,
                        runAttempt: item.observation.runAttempt,
                      },
                      null,
                      2
                    )}
                  </pre>
                </div>
              </DisclosureContent>
            </Disclosure>
          ))}
          {history.data?.items.length === 0 ? <p>No evidence received yet.</p> : null}
        </section>
      ) : null}
    </div>
  )
}
