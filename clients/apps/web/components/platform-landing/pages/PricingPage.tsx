import Link from 'next/link'
import { CalendarIcon as Calendar03Icon } from '@phosphor-icons/react/dist/ssr/Calendar'
import { DatabaseIcon as Database01Icon } from '@phosphor-icons/react/dist/ssr/Database'
import { LightningIcon as FlashIcon } from '@phosphor-icons/react/dist/ssr/Lightning'
import { StackIcon as Layers01Icon } from '@phosphor-icons/react/dist/ssr/Stack'
import { EnvelopeIcon as Mail01Icon } from '@phosphor-icons/react/dist/ssr/Envelope'
import { ShareIcon as Share08Icon } from '@phosphor-icons/react/dist/ssr/Share'
import { SparkleIcon as SparklesIcon } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { UsersIcon as UserGroupIcon } from '@phosphor-icons/react/dist/ssr/Users'
import { CREDIT_PACKS, LAUNCH_CREDITS } from '@/lib/billing/plans'
import { PRODUCT_FACTS } from '@/lib/seo/product-facts'
import { cn } from '@/lib/utils'
import { FaqBlock, MarketingShell, PageHero, TileGrid } from '../blocks'
import { MUTED, Section, SectionIntro } from '../primitives'
import { PlanCards, PlanComparison } from '../pricing'
import { PricingNotice } from '../PricingNotice'
import { CreditMeter } from '../diagrams/CreditMeter'

const EDITOR_TOOLS = [
  { href: '/features/screenshot-beautifier', label: 'Screenshot editor' },
  { href: '/mockup-generator', label: 'Mockup generator' },
  { href: '/store-screenshots', label: 'App Store screenshots' },
  { href: '/code', label: 'Code to image' },
  { href: '/tweet', label: 'Tweet to image' },
  { href: '/remove-background', label: 'Background remover' },
  { href: '/compress-video', label: 'Video compressor' },
  { href: '/tools', label: 'Image tools' },
]

/** /pricing: plan cards, the full comparison, what each limit counts, and billing questions. */
export function PricingPage() {
  return (
    <MarketingShell
      finale={{ lead: 'Start on Pro today', trail: 'and move up when you launch every week.' }}
    >
      <PageHero
        body="Paid plans include the editor, the API, roles, and approval. Higher plans raise every limit. Enterprise adds the controls a security review asks for."
        eyebrow={{ label: 'Pricing' }}
        lead="Pick a plan for how often you ship."
        location="pricing_hero"
        secondary={{ href: '/contact', label: 'Contact sales' }}
        trail="Change plans or cancel any time from the billing portal."
      >
        <PricingNotice />
        <PlanCards location="pricing_cards" />
      </PageHero>

      <Section>
        <SectionIntro
          body="This table comes from the same plan settings that enforce the limits, so it can't promise more than the product delivers."
          label="Compare"
          lead="Compare every limit,"
          trail="read from the code that enforces it."
        />
        <div className="mt-24">
          <PlanComparison />
        </div>
      </Section>

      <Section>
        <SectionIntro
          body="Here is what each limit counts."
          label="What counts"
          lead="Eight limits decide what a plan can do,"
          trail="and using the editor counts toward none of them."
        />
        <div className="mt-24 space-y-12">
          <CreditMeter />
          <TileGrid
            columns={2}
            items={[
              {
                icon: UserGroupIcon,
                title: 'Seats',
                body: 'Each member of the workspace holds a seat. A pending invitation holds one too, until it is accepted or expires.',
              },
              {
                icon: Share08Icon,
                title: 'Social channels',
                body: 'Each connected social account counts once. Reconnecting an account you already have does not count again, and disconnecting one frees it.',
              },
              {
                icon: SparklesIcon,
                title: 'AI credits',
                body: `One credit is one cent of AI cost. A launch uses about ${LAUNCH_CREDITS} credits, and a short copilot edit uses one. At zero, Shots stops before the next AI call.`,
              },
              {
                icon: Calendar03Icon,
                title: 'Scheduled posts',
                body: 'Each post scheduled to a social channel counts once. Links are removed from X posts by default; turn on the Links in X posts add-on ($10/month for 40 link posts every 30 days) in Billing to keep them.',
              },
              {
                icon: Mail01Icon,
                title: 'Release emails',
                body: 'Each recipient of a release email counts once. A send that is refused or fails to queue does not count.',
              },
              {
                icon: FlashIcon,
                title: 'API writes per minute',
                body: "Creates and updates through the REST API, per workspace. Reads are not counted. Launch AI actions have their own per-minute limit, so a burst of clicks can't spend a month of credits in seconds.",
              },
              {
                icon: Layers01Icon,
                title: 'Concurrent jobs',
                body: 'How much background work a workspace can run at the same time: rendering, captures, and AI drafting.',
              },
              {
                icon: Database01Icon,
                title: 'Asset storage',
                body: 'Visuals and captures saved to the workspace, in private storage. Uploads are write-once, and downloads use short-lived signed links.',
              },
            ]}
          />
        </div>
      </Section>

      <Section>
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-8">
          <div>
            <p className="text-[26px] tracking-[-0.02em] text-white sm:text-[30px]">
              Included in every plan
            </p>
            <p className={cn('mt-4 max-w-[480px] text-lg leading-[1.55]', MUTED)}>
              The {PRODUCT_FACTS.license} screenshot editor and its tools run in your browser, are
              included in every plan, and add no watermark.
            </p>
          </div>
          <ul className="grid grid-cols-2 gap-px overflow-hidden border border-[#212121] bg-[#212121]">
            {EDITOR_TOOLS.map((tool) => (
              <li key={tool.href}>
                <Link
                  className="block bg-[#090909] px-5 py-5 text-[15px] text-white/85 transition-colors hover:bg-[#111] hover:text-white"
                  href={tool.href}
                >
                  {tool.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <FaqBlock
        items={[
          {
            q: 'Is there a free plan?',
            a: 'No. Every plan is paid, and Pro already includes media uploads, AI, advanced scheduling, the editor tools and release workflows.',
          },
          {
            q: 'How do I buy Pro or Business?',
            a: 'A workspace admin chooses a plan and pays through Stripe Checkout. The plan applies as soon as Stripe confirms the subscription. Change plans, update cards, or cancel from the billing portal. When a subscription ends, plan features close and the workspace keeps its data.',
          },
          {
            q: 'What happens when I reach a limit?',
            a: `The next AI call, post, or email is refused with a clear error. AI credits, posts, and emails reset on the first of each month (UTC), and API writes reset every minute. To keep going before the reset, buy an extra launch: ${CREDIT_PACKS.launch.credits} AI credits for ${CREDIT_PACKS.launch.price}. They are spent after the allowance and never expire.`,
          },
          {
            q: 'What if a payment fails?',
            a: 'Stripe retries the card, and a past-due workspace keeps its plan for 14 days. After that, plan features close until billing is resolved. Your data stays where it is.',
          },
          {
            q: 'Which plan includes SSO and SCIM?',
            a: (
              <>
                Enterprise, along with signed audit drains, longer audit retention, and legal hold.
                See{' '}
                <Link className="text-white underline-offset-4 hover:underline" href="/enterprise">
                  Enterprise
                </Link>
                .
              </>
            ),
          },
          {
            q: 'Can I self-host instead?',
            a: 'Yes. The platform is open source under Apache 2.0 and ships Docker images and a Helm chart.',
          },
        ]}
      />
    </MarketingShell>
  )
}
