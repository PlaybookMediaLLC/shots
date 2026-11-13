import Link from 'next/link'
import { ArrowUpRightIcon as ArrowUpRight01Icon } from '@phosphor-icons/react/dist/ssr/ArrowUpRight'
import { DatabaseIcon as Database01Icon } from '@phosphor-icons/react/dist/ssr/Database'
import { FingerprintIcon as FingerPrintIcon } from '@phosphor-icons/react/dist/ssr/Fingerprint'
import { KeyIcon as Key01Icon } from '@phosphor-icons/react/dist/ssr/Key'
import { LockIcon as LockIcon } from '@phosphor-icons/react/dist/ssr/Lock'
import { EnvelopeIcon as Mail01Icon } from '@phosphor-icons/react/dist/ssr/Envelope'
import { HardDrivesIcon as ServerStack01Icon } from '@phosphor-icons/react/dist/ssr/HardDrives'
import { ShieldIcon as Shield01Icon } from '@phosphor-icons/react/dist/ssr/Shield'
import { UsersIcon as UserGroupIcon } from '@phosphor-icons/react/dist/ssr/Users'
import { FlowArrowIcon as WorkflowSquare01Icon } from '@phosphor-icons/react/dist/ssr/FlowArrow'
import { LinkedinLogoIcon as Linkedin01Icon } from '@phosphor-icons/react/dist/ssr/LinkedinLogo'
import { InstagramLogoIcon as InstagramIcon } from '@phosphor-icons/react/dist/ssr/InstagramLogo'
import { XLogoIcon as NewTwitterIcon } from '@phosphor-icons/react/dist/ssr/XLogo'
import { NoteIcon as Note01Icon } from '@phosphor-icons/react/dist/ssr/Note'
import { RocketIcon as Rocket01Icon } from '@phosphor-icons/react/dist/ssr/Rocket'
import { z } from 'zod'
import { LAUNCH_CHANNELS, SPEC_SECTIONS } from '@/lib/launch/spec-schema'
import { atLeast, PRODUCT_FACTS } from '@/lib/seo/product-facts'
import { cn } from '@/lib/utils'
import { ArrowLink, FaqBlock } from './blocks'
import { CodeTabs } from './CodeTabs'
import { PlanCards, priceLabel } from './pricing'
import { CreativeMock } from './WorkflowSection'
import { ApprovalFlow } from './diagrams/ApprovalFlow'
import { GuardrailsFlow } from './diagrams/GuardrailsFlow'
import {
  Check,
  CONTAINER,
  MONO,
  MUTED,
  Section,
  SectionIntro,
  Stage,
  Tag,
  Window,
} from './primitives'

// ---------------------------------------------------------------- stats --

const STATS = [
  { value: String(SPEC_SECTIONS.length), label: 'sections in every launch brief' },
  { value: String(LAUNCH_CHANNELS.length), label: 'channels drafted from one release' },
  { value: '0', label: "posts published without a teammate's approval" },
]

/** Sim-style statement with large figures on hairline rows. */
export function StatsSection() {
  return (
    <section className={cn(CONTAINER, 'py-24 sm:py-32')}>
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-24">
        <p className="text-balance text-[24px] leading-[1.3] tracking-[-0.015em] text-white sm:text-[30px]">
          You ship every week. The launch post goes out when someone finds a free afternoon.{' '}
          <span className={MUTED}>
            Shots turns the release you already wrote into the launch you never had time to make.
          </span>
        </p>
        <dl className="divide-y divide-[#212121] border-y border-[#212121]">
          {STATS.map((stat) => (
            <div className="flex items-end justify-between gap-8 py-7" key={stat.label}>
              <dt className="sr-only">{stat.label}</dt>
              <dd className="text-[64px] leading-[0.95] tracking-[-0.045em] text-white sm:text-[84px]">
                {stat.value}
              </dd>
              <dd className={cn('max-w-[220px] pb-2 text-right text-base', MUTED)}>{stat.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- problem --

const WITHOUT = [
  'Crop the screenshot, again',
  'Hunt for the brand hex code',
  'Write five versions of one post',
  'Paste each into a different tool',
  'Chase a teammate for sign-off',
  'Hope nothing claims what the product cannot do',
]

const WITH = [
  'Describe the release once, or let GitHub send it',
  'Check a launch brief where every claim cites a source',
  'Approve a plan for every channel',
  'Review real screenshots, framed on brand',
  'Approve six posts in one click',
  'Publish on schedule, with confirmation',
]

/** The gap between shipping and announcing, as a before and after. */
export function ProblemSection() {
  return (
    <Section>
      <SectionIntro
        body="The feature is live, but the changelog is a commit message. The screenshot sits in Slack, and the post is a draft nobody approved. Work your users never hear about can't win you customers."
        label="The gap"
        lead="Your release shipped."
        trail="Most of your users haven't heard about it."
      />
      <div className="mt-24 grid gap-4 md:grid-cols-2">
        <div className="border border-[#212121] p-8 sm:p-12">
          <p className={cn('text-[15px]', MUTED)}>Every release, by hand</p>
          <ul className="mt-8 space-y-4">
            {WITHOUT.map((item) => (
              <li
                className="flex items-center gap-4 text-lg text-white/55 line-through decoration-white/20"
                key={item}
              >
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-white/25" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-[#111] p-8 sm:p-12">
          <p className={cn('text-[15px]', MUTED)}>Every release, with Shots</p>
          <ul className="mt-8 space-y-4">
            {WITH.map((item) => (
              <li className="flex items-center gap-4 text-lg text-white" key={item}>
                <Check />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------- engine --

/** A browser-framed product shot. */
export function BrowserWidget() {
  return (
    <Window className="w-full max-w-[300px]" meta="Safari · dark" title="Browser frame">
      <CreativeMock className="aspect-[16/11]" />
    </Window>
  )
}

const SWATCHES = ['#0a0a0a', '#3d3d3d', '#9a9a9a', '#f4f4f4', '#34d399']

/** A brand kit card with swatches and type. */
export function BrandWidget() {
  return (
    <Window className="w-full max-w-[300px]" meta="v3" title="Brand kit · Acme">
      <div className="p-4">
        <div className="flex gap-2">
          {SWATCHES.map((color) => (
            <span
              className="size-8 rounded-full border border-white/10"
              key={color}
              style={{ background: color }}
            />
          ))}
        </div>
        <div className="mt-4 flex items-baseline justify-between text-[13px]">
          <span className="text-[#858585]">Heading</span>
          <span className="text-lg tracking-[-0.02em] text-white">Geist 500</span>
        </div>
        <div className="mt-2 flex items-baseline justify-between text-[13px]">
          <span className="text-[#858585]">Applied to</span>
          <span className="text-white">4 visuals</span>
        </div>
      </div>
    </Window>
  )
}

/** An animation timeline with export formats. */
export function TimelineWidget() {
  return (
    <Window className="w-full max-w-[300px]" meta="00:08" title="Timeline">
      <div className="space-y-2.5 p-4">
        {[
          [8, 46, 78],
          [20, 60],
          [32, 70, 90],
        ].map((keys, row) => (
          <div className="relative h-5 rounded bg-white/[0.05]" key={row}>
            {keys.map((left) => (
              <span
                className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-white"
                key={left}
                style={{ left: `${left}%` }}
              />
            ))}
          </div>
        ))}
        <div className="flex gap-1.5 pt-1">
          {['MP4', 'WebM', 'GIF'].map((format) => (
            <Tag key={format}>{format}</Tag>
          ))}
        </div>
      </div>
    </Window>
  )
}

const ENGINE = [
  {
    title: 'Real screens, framed',
    body: 'Safari and Chrome mockups, Arc, macOS, and Windows frames, device shells, and 3D perspective. Shots captures your live product to fill them.',
    widget: <BrowserWidget />,
  },
  {
    title: 'Your brand, applied',
    body: 'Every visual uses your kit: the background gradient, the accent, the text color, and the nearest font. Nobody picks a hex code twice.',
    widget: <BrandWidget />,
  },
  {
    title: 'Motion when it matters',
    body: `${PRODUCT_FACTS.animationPresets} animation presets on a keyframe timeline, exported as MP4, WebM, or GIF in the browser.`,
    widget: <TimelineWidget />,
  },
]

const ENGINE_FACTS = [
  `${atLeast(PRODUCT_FACTS.backgrounds)} backgrounds`,
  `Export up to ${PRODUCT_FACTS.maxExportScale}x`,
  'Annotations and blur',
  'App Store screenshots',
  'Templates with your media',
  `${PRODUCT_FACTS.license} licensed`,
]

/** The editor as the platform's rendering engine. */
export function EngineSection() {
  return (
    <Section id="editor">
      <SectionIntro
        body="Every visual the AI makes opens in the editor as layers. Move anything by hand and save it back to the workspace."
        label="Creative engine"
        lead="Visuals made from your real product"
        trail="that you can edit in the Shots editor."
      >
        <div className="mt-10">
          <ArrowLink href="/product/creative-engine">See the creative engine</ArrowLink>
        </div>
      </SectionIntro>
      <div className="mt-24 grid gap-4 md:grid-cols-3">
        {ENGINE.map((card, index) => (
          <div key={card.title}>
            <Stage className="aspect-[405/320] items-center p-8" variant={index + 1}>
              {card.widget}
            </Stage>
            <h3 className="mt-7 text-xl tracking-[-0.015em] text-white">{card.title}</h3>
            <p className={cn('mt-2 text-base leading-[1.55]', MUTED)}>{card.body}</p>
          </div>
        ))}
      </div>
      <ul className="mt-16 grid grid-cols-2 gap-px overflow-hidden border border-[#212121] bg-[#212121] sm:grid-cols-3 lg:grid-cols-6">
        {ENGINE_FACTS.map((fact) => (
          <li className="bg-[#090909] px-5 py-5 text-[15px] text-white/80" key={fact}>
            {fact}
          </li>
        ))}
      </ul>
    </Section>
  )
}

// ---------------------------------------------------------------- approval --

const ROLES = [
  { role: 'owner', can: 'Billing, SSO, roles, everything' },
  { role: 'admin', can: 'Teammates, brand, channels, releases' },
  { role: 'creator', can: 'Create releases, edit drafts, submit' },
  { role: 'approver', can: 'Approve, reject, request changes' },
  { role: 'publisher', can: 'Schedule and cancel approved posts' },
  { role: 'viewer', can: 'Read everything, change nothing' },
]

/** Approval as a server-side gate, shown as a flow and a role table. */
export function ApprovalSection() {
  return (
    <Section>
      <SectionIntro
        body="Approval is enforced on the server, so the same rules apply in the browser, the API, and the AI. An API key can create a release. It cannot approve a post."
        label="Approval"
        lead="Nothing publishes"
        trail="until a teammate approves it."
      >
        <div className="mt-10">
          <ArrowLink href="/product/approvals">How approval works</ArrowLink>
        </div>
      </SectionIntro>
      <div className="mt-24">
        <ApprovalFlow />
      </div>
      <div className="mt-4">
        <div className="grid gap-12 bg-[#111] p-8 sm:p-12 lg:grid-cols-2">
          <div>
            <p className="text-balance text-[24px] leading-[1.35] tracking-[-0.02em] text-white sm:text-[28px]">
              Every decision is on the record.{' '}
              <span className={MUTED}>
                The audit log saves who approved what together with the change itself.
              </span>
            </p>
          </div>
          <dl className="divide-y divide-[#212121] border-t border-[#212121]">
            {ROLES.map((row) => (
              <div className="flex items-baseline justify-between gap-6 py-3.5" key={row.role}>
                <dt className={cn(MONO, 'text-[13px] text-white')}>{row.role}</dt>
                <dd className={cn('text-right text-[15px]', MUTED)}>{row.can}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------- publishing --

const CHANNELS = [
  { name: 'X', icon: NewTwitterIcon, mode: 'Scheduled' },
  { name: 'LinkedIn', icon: Linkedin01Icon, mode: 'Scheduled' },
  { name: 'Instagram', icon: InstagramIcon, mode: 'Scheduled' },
  { name: 'Email', icon: Mail01Icon, mode: 'Sent' },
  { name: 'Product Hunt', icon: Rocket01Icon, mode: 'Drafted' },
  { name: 'Changelog', icon: Note01Icon, mode: 'Drafted' },
]

const LOG = [
  { id: 'post_8f2a', path: 'SCHEDULED → PROCESSING → PUBLISHED', tone: 'text-emerald-300' },
  { id: 'post_91c4', path: 'retry 429 → PUBLISHED, once', tone: 'text-emerald-300' },
  { id: 'post_a07e', path: 'UNKNOWN_DELIVERY → held for a teammate', tone: 'text-amber-200' },
]

/** A delivery log: a clean publish, a safe retry, and an uncertain delivery held for review. */
export function DeliveryLog() {
  return (
    <Window className="w-full max-w-[460px]" meta="Temporal" title="Delivery log">
      <ul className={cn(MONO, 'divide-y divide-white/[0.06] text-[12px]')}>
        {LOG.map((line) => (
          <li className="flex flex-col gap-1 px-4 py-3" key={line.id}>
            <span className="text-white/50">{line.id}</span>
            <span className={line.tone}>{line.path}</span>
          </li>
        ))}
      </ul>
    </Window>
  )
}

/** Durable delivery and the channels a launch reaches. */
export function PublishingSection() {
  return (
    <Section>
      <SectionIntro
        body="When a post is due, Shots checks its approval, visual, workspace, and destination again. It counts as published only when the network confirms it. If delivery is uncertain, a teammate decides what happens next."
        label="Publishing"
        lead="Each approved post goes out once,"
        trail="and the network confirms it."
      >
        <div className="mt-10">
          <ArrowLink href="/product/publishing">How publishing works</ArrowLink>
        </div>
      </SectionIntro>
      <div className="mt-24 grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {CHANNELS.map(({ icon: Icon, mode, name }) => (
            <li className="flex aspect-[4/3] flex-col justify-between bg-[#111] p-5" key={name}>
              <div className="flex items-start justify-between">
                <Icon aria-hidden="true" className="size-6 text-white" />
                <span className={cn('text-[12px]', MUTED)}>{mode}</span>
              </div>
              <p className="text-[17px] text-white">{name}</p>
            </li>
          ))}
        </ul>
        <Stage className="items-center p-6 sm:p-10" variant={2}>
          <DeliveryLog />
        </Stage>
      </div>
      <p className={cn('mt-8 max-w-[760px] text-[15px] leading-[1.6]', MUTED)}>
        Channel connections are set up with you during early access. Release emails go only to
        subscribers who consented, with one-click unsubscribe and exactly one delivery per address.
      </p>
    </Section>
  )
}

// ---------------------------------------------------------------- guardrails --

const GUARDS = [
  {
    title: 'Prompt-injection defense',
    body: 'Scripts, hidden text, and zero-width characters are stripped. Text that reads like orders to an AI is flagged and shown to the reviewer.',
    snippet: '<source id="S2" trust="untrusted">',
  },
  {
    title: 'Public pages only',
    body: 'Source links can reach public web addresses only. Every address and redirect is checked, and every response is capped in size and time.',
    snippet: 'redirect hop → resolve → public? yes',
  },
  {
    title: 'Citations enforced',
    body: 'A claim that cites nothing, or a source that does not exist, is removed and turned into an open question.',
    snippet: 'proofPoints.2 → openQuestions.0',
  },
  {
    title: 'Copy checks',
    body: 'A post fails if it runs over the channel limit or uses hype words, your banned terms, unknown links, or uncited claims. The AI gets the reason and fixes the post.',
    snippet: 'x: 291 > 280 · rewrite',
  },
  {
    title: "Readers can't act",
    body: "Steps that read sources can't take actions. Your login decides the workspace, and nothing the AI writes or a page says can change it.",
    snippet: 'tools: [] · workspace: session',
  },
  {
    title: 'Metered and audited',
    body: 'Each AI call is charged credits at cost, rate-limited per workspace, and logged with the model and usage.',
    snippet: 'launch.spec · model · tokens',
  },
]

/** How untrusted release sources are handled before and after the model. */
export function GuardrailsSection() {
  return (
    <Section>
      <SectionIntro
        body="Release notes, pull requests, and web pages can hide instructions aimed at an AI. Shots cleans and labels every source before the AI reads it, and checks every output before it is saved."
        label="Guardrails"
        lead="Release notes and web pages can't steer the AI."
        trail="Text that reads like orders is flagged for you."
      >
        <div className="mt-10">
          <ArrowLink href="/product/guardrails">Read about the guardrails</ArrowLink>
        </div>
      </SectionIntro>
      <div className="mt-24 grid gap-4 lg:grid-cols-2">
        <div className="self-start border border-[#212121] p-6 sm:p-8 lg:sticky lg:top-24">
          <GuardrailsFlow compact />
        </div>
        <ul className="grid gap-4">
          {GUARDS.map((guard) => (
            <li className="flex flex-col bg-[#111] p-8 sm:p-10" key={guard.title}>
              <code className={cn(MONO, 'truncate text-[12px] text-white/50')}>
                {guard.snippet}
              </code>
              <h3 className="mt-14 text-[22px] tracking-[-0.015em] text-white">{guard.title}</h3>
              <p className={cn('mt-3 text-base leading-[1.55]', MUTED)}>{guard.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------- developers --

const DEV_LINKS = [
  { href: '/api-reference', title: 'API reference', body: 'Every operation, live in Scalar.' },
  {
    href: '/openapi.json',
    title: 'OpenAPI 3.1',
    body: 'Generated from the same Zod contracts the routes run.',
  },
  {
    href: '/docs/authentication',
    title: 'Scoped keys',
    body: "Five scopes. A key can create releases but can't approve or publish.",
  },
  {
    href: '/llms.txt',
    title: 'llms.txt',
    body: 'Markdown for AI tools. Supported pages answer Accept: text/markdown.',
  },
]

/** REST intake, webhooks, and machine-readable docs. */
export function DevelopersSection() {
  return (
    <Section id="developers">
      <SectionIntro
        body="Post a release from CI or a deploy script, or point a signed webhook at Shots. The release waits in your workspace, ready to become a launch."
        label="Developers"
        lead="Send a release from your pipeline."
        trail="Retries are safe with an idempotency key."
      >
        <div className="mt-10">
          <ArrowLink href="/product/release-intake">Explore release intake</ArrowLink>
        </div>
      </SectionIntro>
      <Stage className="mt-24 px-4 py-12 sm:px-12 sm:py-20" variant={3}>
        <div className="w-full min-w-0 max-w-[760px]">
          <CodeTabs />
        </div>
      </Stage>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {DEV_LINKS.map((link) => (
          <li key={link.href}>
            <Link
              className="group flex h-full flex-col justify-between gap-10 bg-[#111] p-6 transition-colors hover:bg-[#161616]"
              href={link.href}
            >
              <ArrowUpRight01Icon
                aria-hidden="true"
                className="size-5 self-end text-[#858585] transition-colors group-hover:text-white"
              />
              <span>
                <span className="block text-lg text-white">{link.title}</span>
                <span className={cn('mt-1 block text-[15px] leading-[1.5]', MUTED)}>
                  {link.body}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  )
}

// ---------------------------------------------------------------- security --

const CONTROLS = [
  {
    icon: Key01Icon,
    title: 'SSO and SCIM',
    body: 'SAML and OIDC single sign-on, plus SCIM user provisioning and deprovisioning.',
  },
  {
    icon: UserGroupIcon,
    title: 'Six fixed roles',
    body: 'Owner, admin, creator, approver, publisher, viewer. Least privilege by default.',
  },
  {
    icon: Database01Icon,
    title: 'Append-only audit log',
    body: 'The app can add and read audit rows but cannot edit or delete them. IPs are hashed.',
  },
  {
    icon: WorkflowSquare01Icon,
    title: 'Audit log export',
    body: 'Signed CloudEvents to your security log tool (SIEM), with presets for Splunk and Datadog.',
  },
  {
    icon: Shield01Icon,
    title: 'Retention and legal hold',
    body: 'Ninety days by default. Longer retention and legal hold on Enterprise.',
  },
  {
    icon: LockIcon,
    title: 'Private storage',
    body: "Files are kept separate per workspace. Signed links expire in two minutes. Uploads can't be overwritten.",
  },
  {
    icon: FingerPrintIcon,
    title: 'Two-factor',
    body: 'TOTP, required to connect social channels and to configure SSO.',
  },
  {
    icon: Shield01Icon,
    title: 'Workspace isolation',
    body: 'Your login decides which workspace you see. IDs from another workspace return 404, and a test with two workspaces proves it.',
  },
  {
    icon: ServerStack01Icon,
    title: 'Self-hosting',
    body: 'Docker images and a Helm chart in the open-source repository.',
  },
]

/** Enterprise controls as a sim-style hairline capability grid. */
export function SecuritySection() {
  return (
    <Section id="security">
      <SectionIntro
        body="Every request goes through the same permission checks. Each control below is documented in the open-source repository, down to the database role."
        label="Security"
        lead="SSO, six roles, and an append-only audit log,"
        trail="ready for your security review."
      >
        <div className="mt-10">
          <ArrowLink href="/security">Visit the security page</ArrowLink>
        </div>
      </SectionIntro>
      <ul className="mt-24 grid gap-px overflow-hidden rounded-xl border border-[#212121] bg-[#212121] sm:grid-cols-2 lg:grid-cols-3">
        {CONTROLS.map(({ body, icon: Icon, title }) => (
          <li className="bg-[#090909] p-7" key={title}>
            <Icon aria-hidden="true" className="size-5 text-white/80" />
            <h3 className="mt-6 text-base text-white">{title}</h3>
            <p className={cn('mt-1.5 text-[15px] leading-[1.55]', MUTED)}>{body}</p>
          </li>
        ))}
      </ul>
      <div className="mt-12 max-w-3xl">
        <h3 className="text-lg text-white">Google connections, with your permission</h3>
        <p className={cn('mt-3 text-base leading-relaxed', MUTED)}>
          When enabled, Shots lets you connect YouTube to publish videos and view performance,
          connect Google Business Profile to publish posts to your business locations and read their
          performance, or import images and videos you select from Google Drive. Google asks for
          your permission before you connect or import. Drive access is limited to the files you
          select; imported copies are saved in your Shots workspace. You can revoke access in your
          Google Account at any time.
        </p>
        <Link
          className="mt-4 inline-block text-sm text-white underline underline-offset-4"
          href="/privacy-policy#google-user-data"
        >
          How Shots uses, stores, shares, and deletes Google data
        </Link>
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------- roadmap --

/** Delivery state of a roadmap item. */
export const roadmapStatusSchema = z.enum(['Shipped', 'Next', 'Planned'])

/** Delivery state of a roadmap item. */
export type RoadmapStatus = z.infer<typeof roadmapStatusSchema>

const RS = roadmapStatusSchema.enum

const ROADMAP: { status: RoadmapStatus; title: string; body: string }[] = [
  {
    status: RS.Shipped,
    title: 'Launch intelligence',
    body: 'Release, cited launch brief, plan, visuals and posts, review and revise.',
  },
  {
    status: RS.Shipped,
    title: 'Workspace and assets',
    body: 'Save visuals to the workspace, reopen them in the editor, and save again.',
  },
  {
    status: RS.Shipped,
    title: 'Release intake API',
    body: 'REST, scoped keys, idempotency, and signed GitHub and GitLab webhooks.',
  },
  {
    status: RS.Shipped,
    title: 'Screenshots after every deploy',
    body: 'A successful production deploy on GitHub captures fresh screenshots of your product pages.',
  },
  {
    status: RS.Next,
    title: 'Paste a URL, get a week of posts',
    body: 'A product profile to review in seconds, then a first week of posts in minutes.',
  },
  {
    status: RS.Planned,
    title: 'Merged PR to suggested launch',
    body: 'A pull request worth announcing becomes a suggested launch for you to review.',
  },
  {
    status: RS.Planned,
    title: 'Demo videos',
    body: 'Short, captioned demos rendered from captured product flows.',
  },
  {
    status: RS.Planned,
    title: 'The weekly plan',
    body: 'Every Monday, one plan for the week that you approve in one step.',
  },
  {
    status: RS.Planned,
    title: 'Copilot and Autopilot',
    body: 'Suggestions first. Later, automatic publishing within approval rules you switch on.',
  },
]

/** What ships today and what comes next, stated plainly. */
export function RoadmapSection() {
  return (
    <Section>
      <SectionIntro
        body="We built the manual tools first, then step-by-step workflows, then the AI. More automation comes last, and only as far as your approval rules allow."
        label="Roadmap"
        lead="Today you send Shots a release."
        trail="Next, paste a URL and get a first week of posts."
      >
        <div className="mt-10">
          <ArrowLink href="/roadmap">See the full roadmap</ArrowLink>
        </div>
      </SectionIntro>
      <ol className="mt-24 border-t border-[#212121]">
        {ROADMAP.map((item) => (
          <li
            className="grid gap-2 border-b border-[#212121] py-6 sm:grid-cols-[140px_1fr_1.4fr] sm:items-baseline sm:gap-8"
            key={item.title}
          >
            <span
              className={cn(
                MONO,
                'text-[12px] uppercase tracking-[0.06em]',
                item.status === RS.Shipped
                  ? 'text-emerald-400'
                  : item.status === RS.Next
                    ? 'text-white'
                    : MUTED
              )}
            >
              {item.status}
            </span>
            <span className="text-lg text-white">{item.title}</span>
            <span className={cn('text-base', MUTED)}>{item.body}</span>
          </li>
        ))}
      </ol>
    </Section>
  )
}

// ---------------------------------------------------------------- pricing --

/** Plan cards from the entitlement code, with a link to the full comparison. */
export function PricingSection() {
  return (
    <Section id="pricing">
      <SectionIntro
        body="Every plan includes the editor, release intake, and the API. Higher plans raise every limit, and Enterprise adds the controls a security review asks for."
        label="Pricing"
        lead="Three plans."
        trail={`Pro is ${priceLabel('pro').price} a month for teams that ship every week.`}
      >
        <div className="mt-10">
          <ArrowLink href="/pricing">Compare every plan</ArrowLink>
        </div>
      </SectionIntro>
      <div className="mt-24">
        <PlanCards location="landing_pricing" />
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------- faq --

const FAQS = [
  {
    q: 'What is Shots?',
    a: 'A launch platform for software teams. You describe a release, or send it from GitHub. Shots writes a launch brief where every claim cites a source, plans the launch, designs visuals from your real product, and drafts posts for each channel. You approve before anything goes out. The open-source screenshot editor underneath is included in every plan.',
  },
  {
    q: 'Will it ever post without me?',
    a: 'No. Approval is enforced on the server. The AI and API keys can create drafts. Only signed-in teammates can submit posts for review. Only teammates with approval rights can approve, and only approved posts can be scheduled.',
  },
  {
    q: 'Where do the screenshots come from?',
    a: "Your live product. Shots captures your product URL and the release's source links, then lays them out in the editor with your brand kit. Pages behind a login are not supported yet.",
  },
  {
    q: 'How does it avoid making things up?',
    a: `Every claim in the ${SPEC_SECTIONS.length}-section launch brief cites your release or a source. A claim with no source is removed and becomes an open question for you. Posts may only use claims the launch brief contains, and a post that breaks that rule fails the copy checks.`,
  },
  {
    q: 'Which channels does it cover?',
    a: `Posts for all ${LAUNCH_CHANNELS.length} channels: X, LinkedIn, Instagram, Product Hunt, your changelog, and email. Scheduled publishing to X, LinkedIn, and Instagram is in early access, and we set up channel connections with you.`,
  },
  {
    q: 'Can I edit what it makes?',
    a: 'Yes. Edit copy inline, open any visual in the full editor, or ask for a revision and apply it from a diff. Approved posts stay exactly as you approved them.',
  },
  {
    q: 'Do you train models on my content?',
    a: 'No. Each time Shots writes, it looks up your own workspace history: approved posts, rejected posts with notes, and applied revisions. Nothing is shared across workspaces.',
  },
  {
    q: 'Is the editor still open source?',
    a: `Yes. The editor is ${PRODUCT_FACTS.license} licensed, included in every plan, and exports carry no watermark.`,
  },
]

/** Questions people ask before a demo. */
export function FaqSection() {
  return <FaqBlock items={FAQS} />
}
