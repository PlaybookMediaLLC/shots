'use client'

import { CheckIcon as Check } from '@phosphor-icons/react/dist/ssr/Check'
import { SpinnerGapIcon as Loader2 } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import Link from 'next/link'
import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { OnboardingReview } from '@/components/onboarding/OnboardingReview'
import { IdealCustomerProfileForm } from '@/components/workspace/WorkspaceIdealCustomerProfile'
import { ProductProfileForm } from '@/components/workspace/WorkspaceProductProfile'
import { trackOnboarding } from '@/lib/onboarding/funnel'
import { ONBOARDING_POST_COUNT } from '@/lib/onboarding/plan-target'
import type { StoredIdealCustomerProfile } from '@/lib/tenant/ideal-customer-profile'
import type { StoredOnboardingRun } from '@/lib/tenant/onboarding-runs'
import type { StoredProductProfile } from '@/lib/tenant/product-profile'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { getAuthErrorMessage } from './error-message'
import { authInputClassName, FormAlert, SubmitButton } from './fields'
import { Label } from '@/components/ui/label'

const POLL_MS = 2_000

/** The first campaign's stages, shown while they run; the first is the site read. */
const LAUNCH_STEPS = [
  'Reading your site',
  'Writing the brief',
  `Planning ${ONBOARDING_POST_COUNT} posts`,
  'Producing visuals and copy',
]
/** The campaign page to open when a stage stops: spec, plan, then assets. */
const STEP_PAGES = ['spec', 'spec', 'plan', 'assets']

type Stage =
  | { kind: 'url'; manual: boolean; problem: string | null }
  | { kind: 'reading'; startedAt: number }
  | { extracted: boolean; kind: 'review'; run: StoredOnboardingRun }
  | { kind: 'manual' }
  | { campaignId: string | null; error: string | null; kind: 'launching'; step: number }

/** The pages the first campaign cites: the run's best few, as the old read used. */
const CAMPAIGN_PAGES = 4

type LaunchRun = { error: string | null; id: string; resultId: string | null; status: string }

function Heading({ children, lead }: { children: string; lead: string }) {
  return (
    <div>
      <h1 className="text-xl font-medium text-white">{children}</h1>
      <p className="mt-1.5 text-neutral-400">{lead}</p>
    </div>
  )
}

function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(startedAt)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return <>{Math.max(0, Math.round((now - startedAt) / 1_000))}s</>
}

/**
 * Onboarding's product step: paste the product's URL, review the drafts the
 * onboarding agent read from the site while a background run deepens them
 * (or describe it by hand), and confirm. Confirming creates the first
 * campaign and runs spec, plan, and produce on it, then opens its copy for
 * approval. Without the onboarding agent, onboarding is the manual form.
 */
export function OnboardingProduct({
  agentEnabled,
  campaignsEnabled,
  initialIcp,
  initialProfile,
  initialRun,
}: {
  /** The onboarding:agent feature; off means manual-only onboarding. */
  agentEnabled: boolean
  /** Without the campaign workflow, confirming saves the profile and opens the app. */
  campaignsEnabled: boolean
  initialIcp: StoredIdealCustomerProfile | null
  initialProfile: StoredProductProfile | null
  /** The newest run, so a reload resumes its review. */
  initialRun: StoredOnboardingRun | null
}) {
  const trpcClient = useTRPCClient()
  const [profile, setProfile] = useState(initialProfile)
  const [icp, setIcp] = useState(initialIcp)
  const [pages, setPages] = useState<string[]>(
    initialRun?.discoveredUrls.slice(0, CAMPAIGN_PAGES) ?? []
  )
  const [url, setUrl] = useState(initialProfile?.url ?? '')
  const [sentence, setSentence] = useState('')
  const [formKey, setFormKey] = useState(0)
  const [stage, setStage] = useState<Stage>(
    !agentEnabled
      ? { kind: 'manual' }
      : initialProfile && initialRun
        ? { extracted: true, kind: 'review', run: initialRun }
        : initialProfile
          ? { kind: 'manual' }
          : { kind: 'url', manual: false, problem: null }
  )

  async function readSite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    trackOnboarding('onboarding_product_started', { path: 'url' })
    setStage({ kind: 'reading', startedAt: Date.now() })
    try {
      const result = await trpcClient.onboarding.start.mutate({
        sentence: sentence.trim() || undefined,
        url: url.trim(),
      })
      if (!result.productProfile) {
        setStage({
          kind: 'url',
          manual: true,
          problem: `We could not read that site${result.reason ? `: ${result.reason}` : '.'} Describe your product below instead.`,
        })
        return
      }
      setProfile(result.productProfile)
      setIcp(result.idealCustomerProfile)
      setPages(result.pages.slice(0, CAMPAIGN_PAGES))
      setFormKey((key) => key + 1)
      setStage({ extracted: result.extracted, kind: 'review', run: result.run })
    } catch (error) {
      setStage({
        kind: 'url',
        manual: true,
        problem: `${getAuthErrorMessage(error, 'We could not read that site.')} Describe your product below instead.`,
      })
    }
  }

  async function waitFor({ run }: { run: LaunchRun }): Promise<LaunchRun> {
    let current = run
    while (current.status === 'RUNNING') {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      current = (await trpcClient.launch.run.query({ runId: current.id })).run
    }
    if (current.status === 'FAILED') throw new Error(current.error ?? 'The step failed.')
    return current
  }

  async function launch(saved: StoredProductProfile): Promise<void> {
    setProfile(saved)
    trackOnboarding('onboarding_profile_confirmed', {
      extracted: stage.kind === 'review' && stage.extracted,
    })
    if (!campaignsEnabled) {
      window.location.assign('/')
      return
    }
    let campaignId: string | null = null
    let step = 1
    const advance = (next: number) => {
      step = next
      setStage({ campaignId, error: null, kind: 'launching', step })
    }
    advance(1)
    try {
      const started = await trpcClient.onboarding.startCampaign.mutate({ pages })
      campaignId = started.campaignId
      const spec = await waitFor(await trpcClient.launch.spec.generate.mutate({ campaignId }))
      // Approving is a reviewer's call; without the permission, the reviewers take it from here.
      if (!started.canApprove || !spec.resultId) {
        window.location.assign(`/campaigns/${campaignId}/spec`)
        return
      }
      await trpcClient.launch.spec.approve.mutate({ specId: spec.resultId })
      advance(2)
      const plan = await waitFor(
        await trpcClient.launch.plan.generate.mutate({
          campaignId,
          timelineItems: ONBOARDING_POST_COUNT,
        })
      )
      if (!plan.resultId) throw new Error('The plan was not saved.')
      await trpcClient.launch.plan.approve.mutate({ planId: plan.resultId })
      advance(3)
      await waitFor(await trpcClient.launch.produce.mutate({ campaignId }))
      trackOnboarding('onboarding_campaign_ready', { posts: ONBOARDING_POST_COUNT })
      window.location.assign(`/campaigns/${campaignId}/copy`)
    } catch (error) {
      setStage({
        campaignId,
        error: getAuthErrorMessage(error, 'A step failed.'),
        kind: 'launching',
        step,
      })
    }
  }

  if (stage.kind === 'launching') {
    return (
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-8 px-6 py-12">
        <Heading lead="This takes a few minutes. Keep this tab open.">
          {`Creating your first ${ONBOARDING_POST_COUNT} posts`}
        </Heading>
        <ol aria-live="polite" className="flex flex-col gap-4">
          {LAUNCH_STEPS.map((label, index) => {
            const done = index < stage.step
            const active = index === stage.step && !stage.error
            return (
              <li className="flex items-center gap-3 text-sm" key={label}>
                <span
                  aria-hidden
                  className={cn(
                    'grid size-6 place-items-center rounded-full',
                    done ? 'bg-white text-black' : 'border border-white/[0.12] text-neutral-500'
                  )}
                >
                  {done ? (
                    <Check className="size-3.5" />
                  ) : active ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                </span>
                <span className={done || active ? 'text-white' : 'text-neutral-500'}>
                  {label}
                  <span className="sr-only">{done ? ' (done)' : active ? ' (working)' : ''}</span>
                </span>
              </li>
            )
          })}
        </ol>
        {stage.error ? (
          <div className="flex flex-col gap-3">
            <FormAlert>{stage.error}</FormAlert>
            {stage.campaignId ? (
              <Button asChild className="w-fit rounded-lg" variant="outline">
                <Link href={`/campaigns/${stage.campaignId}/${STEP_PAGES[stage.step]}`}>
                  Open the campaign
                </Link>
              </Button>
            ) : (
              <Button
                className="w-fit rounded-lg"
                onClick={() => setStage({ kind: 'manual' })}
                variant="outline"
              >
                Back to your product
              </Button>
            )}
          </div>
        ) : null}
      </div>
    )
  }

  if (stage.kind === 'review' && profile) {
    return (
      <div className="flex flex-1 flex-col gap-8 px-6 py-10">
        <Heading
          lead={
            stage.extracted
              ? 'We read your homepage and are reading the rest of your site. Accept or fix each field; what you accept or edit stays as it is.'
              : 'We could only read your homepage’s title and description so far. The rest fills in as we read your site.'
          }
        >
          Does this look right?
        </Heading>
        <OnboardingReview
          icp={icp}
          key={formKey}
          onConfirm={(confirmed) => void launch(confirmed)}
          onManual={() => setStage({ kind: 'manual' })}
          profile={profile}
          run={stage.run}
        />
      </div>
    )
  }

  if (stage.kind === 'manual' || stage.kind === 'review') {
    return (
      <div className="flex flex-1 flex-col gap-8 px-6 py-10">
        <Heading lead="Describe your product and who it is for. What you write stays as you wrote it.">
          Describe your product
        </Heading>
        <ProductProfileForm
          canManage
          initialUrl={url}
          key={`manual-${formKey}`}
          onSaved={launch}
          profile={profile}
          submitLabel="Looks right"
        />
        <section aria-labelledby="icp-manual-heading" className="flex flex-col gap-4">
          <h2 className="text-base font-medium text-white" id="icp-manual-heading">
            Your ideal customer <span className="text-neutral-500">(optional)</span>
          </h2>
          <IdealCustomerProfileForm
            canManage
            onSaved={setIcp}
            profile={icp}
            submitLabel="Save ideal customer"
          />
        </section>
        {agentEnabled ? (
          <Button variant="custom" size={null}
            className="w-fit text-sm text-neutral-400 underline underline-offset-4 hover:text-white"
            onClick={() => setStage({ kind: 'url', manual: false, problem: null })}
            type="button"
          >
            Read my site instead
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-8 px-6 py-10">
      <form className="mx-auto flex w-full max-w-md flex-col gap-6" onSubmit={readSite}>
        <Heading lead="Paste your product’s URL. Shots reads your site and drafts what it is, who it is for, and what it does.">
          Your product
        </Heading>
        <div className="space-y-2">
          <Label className="text-ui-lg font-medium text-neutral-300" htmlFor="product-site-url">
            Product URL
          </Label>
          <Input
            className={authInputClassName}
            disabled={stage.kind === 'reading'}
            id="product-site-url"
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://acme.com"
            required
            type="url"
            value={url}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-ui-lg font-medium text-neutral-300" htmlFor="product-site-sentence">
            In one sentence, what does it do? <span className="text-neutral-500">(optional)</span>
          </Label>
          <Input
            className={authInputClassName}
            disabled={stage.kind === 'reading'}
            id="product-site-sentence"
            maxLength={300}
            onChange={(event) => setSentence(event.target.value)}
            placeholder="Invoicing that runs itself for small agencies"
            value={sentence}
          />
        </div>
        {stage.kind === 'reading' ? (
          <p aria-live="polite" className="text-sm text-neutral-400" role="status">
            Reading your site… <Elapsed startedAt={stage.startedAt} />. This takes under 10 seconds.
          </p>
        ) : null}
        {stage.kind === 'url' && stage.problem ? <FormAlert>{stage.problem}</FormAlert> : null}
        <SubmitButton busy={stage.kind === 'reading'} busyLabel="Reading your site…">
          Read my site
        </SubmitButton>
        {stage.kind === 'url' && !stage.manual ? (
          <Button variant="custom" size={null}
            className="w-fit text-sm text-neutral-400 underline underline-offset-4 hover:text-white"
            onClick={() => {
              trackOnboarding('onboarding_product_started', { path: 'manual' })
              setStage({ kind: 'url', manual: true, problem: null })
            }}
            type="button"
          >
            Describe it yourself instead
          </Button>
        ) : null}
      </form>
      {stage.kind === 'url' && stage.manual ? (
        <section aria-labelledby="product-manual-heading" className="flex flex-col gap-4">
          <h2 className="text-base font-medium text-white" id="product-manual-heading">
            Describe your product
          </h2>
          <ProductProfileForm
            canManage
            initialUrl={url}
            key={`manual-${formKey}`}
            onSaved={launch}
            profile={profile}
            submitLabel="Looks right"
          />
        </section>
      ) : null}
    </div>
  )
}
