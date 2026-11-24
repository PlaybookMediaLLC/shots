'use client'

import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { OnboardingReview } from '@/components/onboarding/OnboardingReview'
import { IdealCustomerProfileForm } from '@/components/workspace/WorkspaceIdealCustomerProfile'
import { ProductProfileForm } from '@/components/workspace/WorkspaceProductProfile'
import { trackOnboarding } from '@/lib/onboarding/funnel'
import type { StoredIdealCustomerProfile } from '@/lib/tenant/ideal-customer-profile'
import type { StoredOnboardingRun } from '@/lib/tenant/onboarding-runs'
import type { StoredProductProfile } from '@/lib/tenant/product-profile'
import { useTRPCClient } from '@/lib/trpc/react'
import { getAuthErrorMessage } from './error-message'
import { authInputClassName, FormAlert, SubmitButton } from './fields'
import { Label } from '@/components/ui/label'

type Stage =
  | { kind: 'url'; manual: boolean; problem: string | null }
  | { kind: 'reading'; startedAt: number }
  | { extracted: boolean; kind: 'review'; run: StoredOnboardingRun }
  | { kind: 'manual' }
  | { error: string | null; kind: 'launching' }

/** The pages the first campaign cites: the run's best few, as the old read used. */
const CAMPAIGN_PAGES = 4

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
 * campaign and opens its spec page. Generating and approving each version
 * remain explicit actions on the campaign. Without the onboarding agent, onboarding is the manual form.
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

  async function launch(saved: StoredProductProfile): Promise<void> {
    setProfile(saved)
    trackOnboarding('onboarding_profile_confirmed', {
      extracted: stage.kind === 'review' && stage.extracted,
    })
    if (!campaignsEnabled) {
      window.location.assign('/')
      return
    }
    setStage({ error: null, kind: 'launching' })
    const startedAt = Date.now()
    try {
      const started = await trpcClient.onboarding.startCampaign.mutate({ pages })
      trackOnboarding(
        started.created ? 'onboarding_campaign_created' : 'onboarding_campaign_resumed',
        {
          duration_ms: Date.now() - startedAt,
        }
      )
      window.location.assign(`/campaigns/${started.campaignId}/spec`)
    } catch (error) {
      trackOnboarding('onboarding_campaign_failed', { duration_ms: Date.now() - startedAt })
      setStage({
        error: getAuthErrorMessage(error, 'Your campaign could not be opened.'),
        kind: 'launching',
      })
    }
  }

  if (stage.kind === 'launching') {
    return (
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-8 px-6 py-12">
        <Heading lead="Your product profile is saved. Review the campaign brief before generating and approving any material.">
          Opening your first campaign
        </Heading>
        {stage.error ? (
          <div className="flex flex-col gap-3">
            <FormAlert>{stage.error}</FormAlert>
            <Button
              className="w-fit rounded-lg"
              onClick={() => setStage({ kind: 'manual' })}
              variant="outline"
            >
              Back to your product
            </Button>
          </div>
        ) : (
          <p role="status">Opening campaign…</p>
        )}
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
          <Button
            variant="custom"
            size={null}
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
          <Label
            className="text-ui-lg font-medium text-neutral-300"
            htmlFor="product-site-sentence"
          >
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
          <Button
            variant="custom"
            size={null}
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
