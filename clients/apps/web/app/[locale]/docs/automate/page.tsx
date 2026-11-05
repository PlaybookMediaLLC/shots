import { Metadata } from 'next'
import Link from 'next/link'
import { Footer } from '@/components/landing/Footer'
import { Navigation } from '@/components/landing/Navigation'
import { INTER, linkClassName } from '@/lib/seo/docs-shared'
import { OG_DEFAULTS } from '@/lib/seo/metadata'

export const metadata: Metadata = {
  alternates: { canonical: '/docs/automate' },
  description:
    'Turn a GitHub release, a merged pull request, or a production deployment into campaign drafts for review with Shots workflows.',
  openGraph: {
    ...OG_DEFAULTS,
    description: 'Turn shipped code into ready-to-review campaigns with Shots workflows.',
    title: 'Automate your launches',
    url: '/docs/automate',
  },
  title: 'Automate your launches',
}

const heading = 'mb-3 mt-10 text-xl font-semibold tracking-[-0.02em] text-foreground'
const body = 'mb-4 leading-relaxed text-muted-foreground'

/** The public guide to Automate, linked from its empty states. */
export default function AutomateDocsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <Navigation />
      <main className="mx-auto max-w-3xl flex-1 px-6 pt-28 pb-16 sm:pb-24">
        <h1
          className="mb-4 text-3xl font-semibold tracking-[-0.03em] text-foreground sm:text-4xl"
          style={{ fontFamily: INTER }}
        >
          Automate your launches
        </h1>
        <p className="mb-6 text-lg leading-relaxed text-muted-foreground">
          A workflow turns something you shipped into campaign drafts. A person always approves them
          before anything is published. You need a workspace on a plan that includes Automate, and
          an owner or admin to set it up.
        </p>

        <h2 className={heading}>1. Watch a repository</h2>
        <p className={body}>
          In{' '}
          <Link className={linkClassName} href="/workflows/sources">
            Automate › Repositories
          </Link>
          , connect GitHub, choose a repository and select Watch. Shots imports its recent history
          without running anything.
        </p>

        <h2 className={heading}>2. Pick a template</h2>
        <p className={body}>
          <Link className={linkClassName} href="/workflows/new">
            New workflow
          </Link>{' '}
          lists a template for each kind of event: a published release, a merged pull request, a
          production deployment, a version tag, or a closed milestone. Each card says what starts
          it, what it skips and what you get. Choosing one opens it in the editor, where you can
          pick your brand kit and channels and change every step.
        </p>

        <h2 className={heading}>3. Test and activate</h2>
        <p className={body}>
          Test draft shows the path an example or recorded event would take. It creates nothing and
          calls no AI model. When you are ready, select Activate version. Only new events run, and
          each run keeps the version it started with. If several workflows match the same event, the
          lowest priority number runs.
        </p>

        <h2 className={heading}>4. See what happened</h2>
        <p className={body}>
          <Link className={linkClassName} href="/workflows/runs">
            Automate › Runs
          </Link>{' '}
          lists every event and what each workflow did with it. Its campaign drafts wait in review
          for a person to approve.
        </p>

        <h2 className={heading}>Start from a deployment</h2>
        <p className={body}>
          A deployment workflow needs one more step. Activate it, then open{' '}
          <Link className={linkClassName} href="/workflows/deployments">
            Automate › Deployments
          </Link>
          , connect your host (Vercel, Netlify, Cloudflare or GitHub), choose the watched
          repository, and select the workflow under Shots workflow after a match.
        </p>

        <h2 className={heading}>What if no workflow handles a repository?</h2>
        <p className={body}>
          Merged pull requests wait in the{' '}
          <Link className={linkClassName} href="/campaigns/releases">
            Release inbox
          </Link>
          , where you can start a campaign by hand. Runs shows these as handled by Release inbox.
        </p>
      </main>
      <Footer />
    </div>
  )
}
