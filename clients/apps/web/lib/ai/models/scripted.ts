import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'
import { testHooksAllowed } from '@/lib/e2e-hooks'

/**
 * A deterministic stand-in model for end-to-end tests, so the launch pipeline
 * runs without a provider key or network.
 *
 * It reads the same prompts the real model gets and answers each stage's
 * submit tool with a valid, plain submission built from the brief, the
 * sources, the spec, and the plan in the prompt. It never cites flagged
 * sources and never follows text inside them. It is not a quality bar for the
 * real model; it exercises wiring, validation, persistence, and the UI.
 *
 * Enabled only with PLATFORM_AI_SCRIPTED=1, and in a production build only
 * when that build is serving an end-to-end stack (lib/e2e-hooks.ts).
 */

export function isScriptedModelEnabled(): boolean {
  return process.env.PLATFORM_AI_SCRIPTED === '1' && testHooksAllowed()
}

type ToolCall = { input: unknown; toolName: string }
type ToolResult = { output: unknown; toolName: string }

function readPrompt(options: LanguageModelV4CallOptions) {
  const texts: string[] = []
  const calls: ToolCall[] = []
  const results: ToolResult[] = []
  for (const message of options.prompt) {
    if (message.role === 'system') continue
    for (const part of message.content as unknown as Array<Record<string, unknown>>) {
      if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
      if (part.type === 'tool-call') {
        let input: unknown = part.input
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input)
          } catch {
            // keep the raw string
          }
        }
        calls.push({ input, toolName: String(part.toolName) })
      }
      if (part.type === 'tool-result') {
        const output = part.output as { type?: string; value?: unknown } | undefined
        let value: unknown = output?.value
        if (output?.type === 'content' && Array.isArray(value)) {
          const text = (value as Array<{ text?: string; type: string }>).find(
            (item) => item.type === 'text'
          )
          try {
            value = text?.text ? JSON.parse(text.text) : value
          } catch {
            value = text?.text
          }
        }
        results.push({ output: value, toolName: String(part.toolName) })
      }
    }
  }
  return { calls, results, text: texts.join('\n\n') }
}

function systemText(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n')
}

function toolNames(options: LanguageModelV4CallOptions): string[] {
  return (options.tools ?? []).map((tool) => ('name' in tool ? tool.name : '')).filter(Boolean)
}

function toolProperties(options: LanguageModelV4CallOptions, name: string): string[] {
  const tool = (options.tools ?? []).find((entry) => 'name' in entry && entry.name === name)
  const schema =
    tool && 'inputSchema' in tool
      ? (tool.inputSchema as { properties?: Record<string, unknown> })
      : null
  return Object.keys(schema?.properties ?? {})
}

const clip = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`
const firstSentence = (value: string) => (value.match(/^[^.!?]+[.!?]?/)?.[0] ?? value).trim()

let callCounter = 0
const callId = () => `scripted-${Date.now().toString(36)}-${(callCounter += 1)}`

function toolCalls(calls: Array<{ input: unknown; toolName: string }>): LanguageModelV4Content[] {
  return calls.map((call) => ({
    input: JSON.stringify(call.input),
    toolCallId: callId(),
    toolName: call.toolName,
    type: 'tool-call' as const,
  }))
}

// ------------------------------------------------------------------ spec --

type ParsedSource = { flagged: boolean; id: string; text: string }

function parseSources(text: string): ParsedSource[] {
  const sources: ParsedSource[] = []
  const pattern = /<source id="(S\d+)"[^>]*?flagged="(true|false)"[^>]*>\n([\s\S]*?)\n<\/source>/g
  for (const match of text.matchAll(pattern)) {
    sources.push({ flagged: match[2] === 'true', id: match[1]!, text: match[3]! })
  }
  return sources
}

function field(text: string, label: string): string {
  return text.match(new RegExp(`^${label}: (.+)$`, 'm'))?.[1]?.trim() ?? ''
}

function facts(source: ParsedSource): string[] {
  return source.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(- |#+ )/.test(line))
    .map((line) => line.replace(/^(- |#+ )/, '').trim())
    .filter((line) => line.length > 8 && line.length < 400)
    .slice(0, 8)
}

function scriptSpec(text: string) {
  const title = field(text, 'Release title') || 'This release'
  const why = field(text, 'Why it matters') || `${title} is now available.`
  const audience = field(text, 'Audience')
  const citable = (text.match(/You may cite: ([^\n]+?)\.\n/)?.[1] ?? 'brief')
    .split(',')
    .map((value) => value.trim())
  const clean = parseSources(text).filter(
    (source) => !source.flagged && citable.includes(source.id)
  )
  const evidence = clean.flatMap((source) => facts(source).map((fact) => ({ fact, id: source.id })))
  const capabilityFacts = evidence.filter((entry) => /[:—–]/.test(entry.fact)).slice(0, 3)
  const capabilities = (capabilityFacts.length ? capabilityFacts : evidence.slice(0, 2)).map(
    ({ fact, id }) => {
      const [name, ...rest] = fact.split(/\s*[:—–]\s*/)
      return {
        description: clip(rest.join(' ') || fact, 600),
        name: clip(name || fact, 120),
        sources: [id],
      }
    }
  )
  if (capabilities.length === 0)
    capabilities.push({ description: clip(why, 600), name: clip(title, 120), sources: ['brief'] })
  const firstSource = clean[0]?.id
  return {
    audience: audience
      ? [{ need: clip(why, 500), segment: clip(audience, 160), sources: ['brief'] }]
      : [],
    beforeAfter: [],
    capabilities,
    faqs: [
      {
        answer: clip(audience ? `${title} is for ${audience}.` : why, 800),
        question: clip(`Who is ${title} for?`, 300),
        sources: ['brief'],
      },
    ],
    limitations: [],
    messaging: {
      ctas: [clip(`Try ${title}`, 120)],
      pillars: [
        { message: clip(why, 500), sources: ['brief'], title: 'Why it matters' },
        {
          message: capabilities[0]!.description,
          sources: capabilities[0]!.sources,
          title: capabilities[0]!.name,
        },
      ],
      positioning: { alternatives: [], sources: [], statement: '' },
    },
    openQuestions: [
      {
        answer: '',
        question: 'What measurable result can we cite?',
        reason: 'No source gives a number for the outcome.',
        section: 'proofPoints',
      },
      ...(audience
        ? []
        : [
            {
              answer: '',
              question: 'Who is the primary audience?',
              reason: 'The brief does not say.',
              section: 'audience',
            },
          ]),
    ],
    problem: [{ sources: ['brief'], text: clip(why, 600) }],
    proofPoints: [],
    summary: {
      sources: firstSource ? ['brief', firstSource] : ['brief'],
      text: clip(`${title}: ${why}${evidence[0] ? ` ${evidence[0].fact}` : ''}`, 1_200),
    },
    whatChanged: (evidence.length ? evidence.slice(0, 3) : [{ fact: title, id: 'brief' }]).map(
      ({ fact, id }) => ({
        sources: [id],
        text: clip(fact, 600),
      })
    ),
  }
}

// ------------------------------------------------------------------ plan --

type Claim = { ref: string; text: string }

function parseClaims(text: string): Claim[] {
  const block =
    text.match(/Claims \(cite these refs\):\n([\s\S]*?)(\nUnknowns|\n<\/spec>)/)?.[1] ?? ''
  return block
    .split('\n')
    .map((line) => line.match(/^- ([A-Za-z.]+(?:\.\d+)?): (.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ ref: match[1]!, text: match[2]! }))
}

function captureUrls(text: string): string[] {
  const block = text.match(/<capture_urls>\n([\s\S]*?)\n<\/capture_urls>/)?.[1] ?? ''
  return block.split('\n').filter((line) => /^https?:\/\//.test(line))
}

/** The fixed post count and channels a plan prompt asks for, if any (see planTargetLine). */
function planTarget(text: string): { channels: string[]; count: number } | null {
  const match = text.match(
    /Plan exactly (\d+) timeline items, one post each, using only these channels: ([a-z_, ]+)\./
  )
  if (!match) return null
  return {
    channels: match[2]!.split(',').map((channel) => channel.trim()),
    count: Number(match[1]),
  }
}

/** A week of posts on the target channels in turn: a teaser, launch day, then follow-ups. */
function targetTimeline(target: { channels: string[]; count: number }) {
  return Array.from({ length: target.count }, (_, index) => {
    const day = index === 0 ? -1 : index <= target.channels.length ? 0 : index
    return {
      angleKey: index % 2 === 0 ? 'G1' : 'G2',
      assetKeys: [index % 2 === 0 ? 'A1' : 'A2'],
      channel: target.channels[index % target.channels.length]!,
      day,
      note: day < 0 ? 'Teaser' : day === 0 ? '' : 'Follow-up',
      phase: day < 0 ? 'teaser' : day === 0 ? 'launch' : 'follow_up',
    }
  })
}

function scriptPlan(text: string) {
  const target = planTarget(text)
  const claims = parseClaims(text)
  const pick = (prefix: string) => claims.find((claim) => claim.ref.startsWith(prefix))
  const pillar = pick('messaging.pillars') ?? claims[0]!
  const capability = pick('capabilities') ?? pillar
  const headline = clip(capability.text.split(':')[0] ?? capability.text, 60)
  return {
    angles: [
      {
        hook: clip(pillar.text, 400),
        key: 'G1',
        pillar: clip(pillar.text.split(':')[0]!, 160),
        specRefs: [pillar.ref],
        title: 'The outcome',
      },
      {
        hook: clip(capability.text, 400),
        key: 'G2',
        pillar: clip(capability.text.split(':')[0]!, 160),
        specRefs: [capability.ref],
        title: 'How it works',
      },
    ],
    assets: [
      {
        angleKey: 'G1',
        capability: clip(capability.text.split(':')[0]!, 160),
        captureHint: { device: 'desktop', focus: 'The main product screen', url: '' },
        format: '16:9',
        headline,
        key: 'A1',
        kind: 'hero',
        variants: 2,
      },
      {
        angleKey: 'G2',
        capability: clip(capability.text.split(':')[0]!, 160),
        captureHint: {
          device: 'desktop',
          focus: 'The feature in use',
          url: captureUrls(text)[0] ?? '',
        },
        format: '1:1',
        headline,
        key: 'A2',
        kind: 'social_card',
        variants: 1,
      },
    ],
    channels: (target
      ? target.channels.map((channel) => ({
          cadence: 'Across the launch week',
          channel,
          role: 'Reach the people the product is for',
        }))
      : null) ?? [
      {
        cadence: 'A teaser, launch day, and one follow-up',
        channel: 'x',
        role: 'Reach practitioners where they talk shop',
      },
      {
        cadence: 'Launch day and one follow-up',
        channel: 'linkedin',
        role: 'Reach buyers and decision makers',
      },
      { cadence: 'Launch day', channel: 'product_hunt', role: 'Reach early adopters' },
      { cadence: 'Launch day', channel: 'changelog', role: 'Tell existing users what changed' },
      { cadence: 'Launch day', channel: 'email', role: 'Tell customers directly' },
    ],
    summary:
      'Lead with the outcome on launch day across every channel, then follow up with how it works.',
    timeline: (target ? targetTimeline(target) : null) ?? [
      { angleKey: 'G1', assetKeys: ['A2'], channel: 'x', day: -2, note: 'Teaser', phase: 'teaser' },
      { angleKey: 'G1', assetKeys: ['A1'], channel: 'x', day: 0, note: '', phase: 'launch' },
      { angleKey: 'G1', assetKeys: ['A1'], channel: 'linkedin', day: 0, note: '', phase: 'launch' },
      {
        angleKey: 'G1',
        assetKeys: ['A1'],
        channel: 'product_hunt',
        day: 0,
        note: '',
        phase: 'launch',
      },
      { angleKey: 'G2', assetKeys: [], channel: 'changelog', day: 0, note: '', phase: 'launch' },
      { angleKey: 'G1', assetKeys: ['A1'], channel: 'email', day: 0, note: '', phase: 'launch' },
      {
        angleKey: 'G2',
        assetKeys: ['A2'],
        channel: 'linkedin',
        day: 3,
        note: 'How it works',
        phase: 'follow_up',
      },
    ],
  }
}

// ------------------------------------------------------------------ copy --

type PlanShape = ReturnType<typeof scriptPlan>

function parsePlan(text: string): PlanShape | null {
  const json = text.match(/<plan version="\d+">\n([\s\S]*?)\n<\/plan>/)?.[1]
  try {
    return json ? (JSON.parse(json) as PlanShape) : null
  } catch {
    return null
  }
}

function scriptCopy(text: string) {
  const claims = parseClaims(text)
  const plan = parsePlan(text)
  if (!plan) return { posts: [] }
  const claimFor = (ref: string) => claims.find((claim) => claim.ref === ref) ?? claims[0]!
  const requested = text.match(/Write the ([a-z_]+) posts:/)?.[1]
  const channels = plan.channels.filter(({ channel }) => !requested || channel === requested)
  // One post per timeline item, as the prompt asks; angles take turns so posts differ.
  const posts = channels.flatMap(({ channel }) =>
    plan.timeline
      .filter((item) => item.channel === channel)
      .map((item, index) => {
        const angle = plan.angles[index % plan.angles.length]!
        // Past the first round of angles, the day keeps repeated posts distinct.
        const lead = index < plan.angles.length ? '' : `Day ${item.day}: `
        const claim = claimFor(angle.specRefs[0]!)
        const fact = claim.text.replace(/^[^:]{1,80}:\s*/, '')
        const base = {
          angleKey: angle.key,
          claims: [{ ref: claim.ref, text: clip(claim.text, 300) }],
          phase: item.phase,
        }
        switch (channel) {
          case 'x':
            return {
              ...base,
              callToAction: 'Try it today.',
              channel,
              copy: clip(`${lead}${angle.title}: ${fact}`, 240),
              title: '',
            }
          case 'linkedin':
            return {
              ...base,
              callToAction: 'Try it today.',
              channel,
              copy: `${lead}${angle.hook}\n\n${fact}\n\nIt is available now.`,
              title: '',
            }
          case 'product_hunt':
            return {
              ...base,
              callToAction: '',
              channel,
              copy: clip(fact, 250),
              title: clip(angle.title, 60),
            }
          case 'changelog':
            return {
              ...base,
              callToAction: '',
              channel,
              copy: `- ${fact}`,
              title: clip(angle.title, 100),
            }
          case 'email':
            return {
              ...base,
              callToAction: 'Try it today.',
              channel,
              copy: `Hi there,\n\n${angle.hook}\n\n${fact}`,
              title: clip(`New: ${angle.title}`, 90),
            }
          default:
            return { ...base, callToAction: '', channel, copy: clip(fact, 2_000), title: '' }
        }
      })
  )
  return { posts }
}

// ------------------------------------------------------------- revisions --

function block(text: string, tag: string): string | null {
  return text.match(new RegExp(`<${tag}[^>]*>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? null
}

function revisionLead(comment: string): string {
  if (/time|hour|faster|quick/i.test(comment)) return 'Get hours back each month.'
  return clip(firstSentence(comment).replace(/^(please\s+)?(make it|make this|be)\s+/i, ''), 80)
}

function scriptRevision(text: string, properties: string[]) {
  const comment = block(text, 'reviewer_comment') ?? 'Revise it.'
  const lead = revisionLead(comment)
  if (properties.includes('changes')) {
    const design = JSON.parse(block(text, 'design') ?? '{}') as {
      texts?: Array<Record<string, unknown>>
    }
    const texts = (design.texts ?? []).map((entry, index) =>
      index === 0 ? { ...entry, text: clip(lead, 120) } : entry
    )
    return { changes: texts.length ? { texts } : {}, summary: `Headline now leads with: ${lead}` }
  }
  if (properties.includes('relatedPosts')) {
    const section = JSON.parse(block(text, 'section') ?? 'null') as unknown
    const revised = Array.isArray(section)
      ? section.map((item, index) =>
          index === 0 && item && typeof item === 'object' && 'text' in item
            ? { ...item, text: clip(`${lead} ${(item as { text: string }).text}`, 600) }
            : item
        )
      : section
    return { after: revised, relatedPosts: [], summary: `Section now leads with: ${lead}` }
  }
  const plan = parsePlan(text)
  if (plan && /<plan version/.test(text) && !block(text, 'post')) {
    return {
      after: { ...plan, summary: clip(`${lead} ${plan.summary}`, 800) },
      summary: `Plan now leads with: ${lead}`,
    }
  }
  const post = JSON.parse(block(text, 'post') ?? '{}') as {
    callToAction: string
    claims: unknown
    copy: string
    title: string
  }
  const channel = text.match(/<post channel="([a-z_]+)"/)?.[1] ?? 'linkedin'
  const limit =
    channel === 'x'
      ? 270 - (post.callToAction?.length ?? 0)
      : channel === 'product_hunt'
        ? 250
        : 2_800
  return {
    after: { ...post, copy: clip(`${lead} ${post.copy}`, limit) },
    summary: `Leads with: ${lead}`,
  }
}

// --------------------------------------------------------------- visuals --

function scriptVisuals(text: string, results: ToolResult[], calls: ToolCall[]): ToolCall[] | null {
  const capture = results.find((result) => result.toolName === 'captureProductPage')?.output as
    { assetId?: string; ok?: boolean } | undefined
  if (!calls.some((call) => call.toolName === 'captureProductPage')) {
    const url = captureUrls(text)[0]
    return url
      ? [
          {
            input: { colorScheme: 'light', device: 'desktop', url },
            toolName: 'captureProductPage',
          },
        ]
      : null
  }
  if (
    !capture?.ok ||
    !capture.assetId ||
    calls.some((call) => call.toolName === 'createProductShot')
  )
    return null
  const plan = parsePlan(text)
  const brand = text.match(
    /background gradient from (#[0-9a-f]{6}) to (#[0-9a-f]{6}).*?text (#[0-9a-f]{6})/i
  )
  const palettes = [
    { from: brand?.[1] ?? '#1e1b4b', text: brand?.[3] ?? '#ffffff', to: brand?.[2] ?? '#7c3aed' },
    { from: brand?.[2] ?? '#0f172a', text: brand?.[3] ?? '#ffffff', to: brand?.[1] ?? '#2563eb' },
  ]
  const format = (value: string) =>
    value === '16:9'
      ? 'landscape'
      : value === '9:16'
        ? 'story'
        : value === '4:5'
          ? 'portrait'
          : 'square'
  return (plan?.assets ?? []).flatMap((asset) =>
    Array.from({ length: asset.variants }, (_, index) => ({
      input: {
        background: { from: palettes[index]!.from, to: palettes[index]!.to },
        caption: `${asset.capability} (${asset.key}${asset.variants > 1 ? ` ${index === 0 ? 'A' : 'B'}` : ''})`,
        captureAssetId: capture.assetId,
        format: format(asset.format),
        headline: clip(asset.headline, 50),
        mockupId: 'macbook-pro-14-front',
        planAssetKey: asset.key,
        textColor: palettes[index]!.text,
        ...(asset.variants > 1 ? { variantLabel: index === 0 ? 'A' : 'B' } : {}),
      },
      toolName: 'createProductShot',
    }))
  )
}

// ------------------------------------------------------------- marketing --

/**
 * The marketing agent's script: read the product and brand, then submit the
 * posts the prompt lists (a `Post ids: a, b` line) for review, then stop.
 */
function scriptApproval(text: string, names: string[], calls: ToolCall[]): ToolCall[] | null {
  const reads = ['getProduct', 'getBrand'].filter((name) => names.includes(name))
  if (reads.length > 0 && !calls.some((call) => reads.includes(call.toolName))) {
    return reads.map((toolName) => ({ input: {}, toolName }))
  }
  if (calls.some((call) => call.toolName === 'requestApproval')) return null
  const postIds = (text.match(/^Post ids: (.+)$/m)?.[1] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return postIds.length > 0 ? [{ input: { postIds }, toolName: 'requestApproval' }] : null
}

// ---------------------------------------------------------- conversation --

/** The user messages of the prompt, oldest first. */
function userTexts(options: LanguageModelV4CallOptions): string[] {
  return options.prompt.flatMap((message) =>
    message.role === 'user'
      ? (message.content as unknown as Array<Record<string, unknown>>)
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => String(part.text))
      : []
  )
}

const SHIPPED =
  /\b(?:shipped|launched|released|added|built)\s+(?:a |an |the |our )?(.+?)(?:[.!?]|$)/i

type ScriptedSurface = { name: string; reason?: string; slug: string }
type ScriptedResult = {
  assetCount?: number
  error?: string
  name?: string
  ok?: boolean
  postCount?: number
  surface?: string
  surfaces?: ScriptedSurface[]
}

/**
 * The campaign agent's script (RFC 028): read the product, brand, and the
 * pages that match the shipped feature; ask once when several match (and the
 * question tool is offered), otherwise create the campaign on the one match
 * or the homepage, draft it, and report with the assumptions stated. "Approve"
 * gets a refusal and no tool calls.
 */
function scriptConversation(
  options: LanguageModelV4CallOptions,
  names: string[],
  calls: ToolCall[],
  results: ToolResult[]
): LanguageModelV4Content[] {
  const users = userTexts(options)
  const last = users.at(-1) ?? ''
  const called = (name: string) => calls.some((call) => call.toolName === name)
  const output = (name: string) =>
    results.findLast((result) => result.toolName === name)?.output as ScriptedResult | undefined
  if (/\bapprove\b/i.test(last)) {
    return [
      {
        text: 'I cannot approve posts. A person approves them on the campaign’s Copy page.',
        type: 'text',
      },
    ]
  }
  const shipped = users.findLast((text) => SHIPPED.test(text)) ?? last
  const feature = clip(shipped.match(SHIPPED)?.[1]?.trim() || firstSentence(shipped), 120)
  if (!called('listProductSurfaces')) {
    return toolCalls([
      { input: {}, toolName: 'getProduct' },
      { input: {}, toolName: 'getBrand' },
      { input: { feature, limit: 5 }, toolName: 'listProductSurfaces' },
    ])
  }
  const matches = (output('listProductSurfaces')?.surfaces ?? []).filter(
    (surface) => surface.reason !== 'fallback'
  )
  if (!called('createCampaign')) {
    if (matches.length > 1 && names.includes('askClarification')) {
      return toolCalls([
        {
          input: {
            options: matches.slice(0, 6).map((surface) => surface.name),
            question: `Which page shows ${feature}?`,
          },
          toolName: 'askClarification',
        },
      ])
    }
    const chosen =
      matches.find((surface) => last.toLowerCase().includes(surface.name.toLowerCase())) ??
      matches[0]
    return toolCalls([
      {
        input: {
          benefit: clip(`${feature} is now available.`, 200),
          feature,
          ...(chosen ? { surfaceSlug: chosen.slug } : {}),
        },
        toolName: 'createCampaign',
      },
    ])
  }
  const created = output('createCampaign')
  if (created?.ok && !called('generateCampaign')) {
    return toolCalls([{ input: {}, toolName: 'generateCampaign' }])
  }
  const generated = output('generateCampaign')
  const page = matches.length
    ? `I used your ${created?.surface ?? matches[0]!.name} page${matches.length > 1 ? ', which I assumed is the one you meant' : ''}.`
    : 'No page matched, so I assumed your homepage shows it.'
  const lines = created?.ok
    ? [
        created.name ? `I created the campaign “${created.name}”.` : 'I worked on this campaign.',
        page,
        generated?.ok
          ? `I drafted ${generated.postCount ?? 0} posts and ${generated.assetCount ?? 0} visuals.`
          : `I could not draft the posts: ${generated?.error ?? 'the step failed'} You can retry that step.`,
        'I assumed the workspace’s default channels.',
      ]
    : [`I could not create the campaign: ${created?.error ?? 'the step failed'}`]
  return [{ text: lines.join(' '), type: 'text' }]
}

/** Three link preview copy options that pass the length checks, built from the page's title. */
function scriptLinkCopy(text: string) {
  const name = (text.match(/^- title: (.+)$/m)?.[1] ?? 'This page').replace(/\s+/g, ' ').trim()
  const short = name.length > 40 ? `${name.slice(0, 39).trimEnd()}` : name
  const angles = [
    { angle: 'Main benefit', lead: 'what it does', pitch: 'what it does for you' },
    { angle: 'Problem solved', lead: 'why it matters', pitch: 'the problem it solves' },
    { angle: 'Who it is for', lead: 'who it is for', pitch: 'who it is built for' },
  ]
  return {
    variants: angles.map(({ angle, lead, pitch }) => ({
      angle,
      description: clip(
        `See ${pitch} on ${short}. A clear, factual summary of the page for social cards and search.`,
        160
      ),
      title: clip(`${short}: ${lead}`.padEnd(30, '.'), 60),
    })),
  }
}

// -------------------------------------------------------- product profile --

/**
 * A product profile from the onboarding read: the homepage's title as the
 * name, its first lines as the summary, list items with a colon as
 * capabilities, the pricing page's first line, and lines with a number as
 * proof points. Every value cites its readable, unflagged source.
 */
// ---------------------------------------------------------------- model --

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 0, total: 0 },
  outputTokens: { reasoning: 0, text: 0, total: 0 },
}

/** Distinct, catalog-valid versions of a design, for the variants flow. */
function scriptVariants(text: string, done: number): ToolCall[] {
  const count = Number(text.match(/Propose (\d+) versions/)?.[1] ?? 4)
  const versions = [
    {
      changes: { canvas: { aspectRatio: '1_1' }, image: { perspective: { rotateX: 8, rotateY: -14 }, scale: 85 } },
      reason: 'A square crop with a gentle 3D tilt for feeds.',
      title: 'Tilted square',
    },
    {
      changes: { canvas: { aspectRatio: '9_16' }, image: { frame: { type: 'macos-dark' }, scale: 90 } },
      reason: 'A tall story format with a dark window frame.',
      title: 'Story window',
    },
    {
      changes: { background: { type: 'solid', value: '#0f172a' }, image: { frame: { type: 'arc-light' }, shadow: { preset: 'strong' } } },
      reason: 'A browser frame on a deep navy background.',
      title: 'Browser on navy',
    },
    {
      changes: {
        background: { type: 'gradient', value: 'linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)' },
        canvas: { padding: 120 },
        image: { radius: 24, rotation: -4 },
      },
      reason: 'More breathing room, rounder corners, and a slight angle.',
      title: 'Airy angle',
    },
    {
      changes: { canvas: { aspectRatio: '4_5' }, image: { perspective: { rotateX: 18 } } },
      reason: 'A portrait crop with the screenshot laid back in perspective.',
      title: 'Laid back',
    },
    {
      changes: { canvas: { aspectRatio: '16_9' }, image: { frame: { type: 'glass-dark' }, scale: 70 } },
      reason: 'A wide banner with a glass frame and a smaller screenshot.',
      title: 'Glass banner',
    },
  ]
  return versions.slice(done, count).map((input) => ({ input, toolName: 'proposeVariant' }))
}

/** Alt text and captions built from the design's own text, within each platform's limit. */
function scriptCaptions(text: string) {
  const channels = (text.match(/<channels>([^<]*)<\/channels>/)?.[1] ?? 'x').split(',').filter(Boolean)
  const visible = text.match(/<visible-text>([^<]*)<\/visible-text>/)?.[1] ?? ''
  const headline = visible && visible !== '(none)' ? visible.split(' | ')[0]!.trim() : ''
  const subject = headline ? `“${headline}”` : 'the new release'
  return {
    altText: headline ? `A product screenshot with the headline “${headline}”.` : 'A product screenshot.',
    captions: channels.map((channel) => ({
      channel,
      text: channel === 'instagram' ? `Meet ${subject}.\n\n#product #launch #design` : `Meet ${subject}. Take a look.`,
    })),
  }
}

/**
 * Write's Refine (RFC 025): one text per <text>, plainly changed, so a
 * test can tell the refinement from the original. A title is the first
 * words of the first text.
 */
function scriptRefinement(text: string, system: string) {
  const texts = [...text.matchAll(/<text index="\d+">([\s\S]*?)<\/text>/g)].map((match) => match[1]!.trim())
  if (system.includes('internal title')) {
    return { texts: [clip((texts[0] ?? 'Draft').split(/\s+/).slice(0, 6).join(' '), 60)] }
  }
  return { texts: texts.map((item) => `${item.replace(/\s+/g, ' ')} (refined)`) }
}

function respond(content: LanguageModelV4Content[]): LanguageModelV4GenerateResult {
  const hasCalls = content.some((part) => part.type === 'tool-call')
  return {
    content,
    finishReason: { raw: undefined, unified: hasCalls ? 'tool-calls' : 'stop' },
    usage,
    warnings: [],
  }
}

const SUBMIT_TOOLS = [
  'submitRefinement',
  'submitSpec',
  'submitPlan',
  'saveLaunchCopy',
  'proposeRevision',
  'submitCritique',
  'submitLinkCopy',
  'submitCaptions',
  'submitTranslations',
  'submitCopySuggestions',
  'submitGridLines',
] as const

// ------------------------------------------------- store screenshots --

function jsonAfter(text: string, label: string): unknown {
  const start = text.indexOf(`${label}:\n`)
  if (start === -1) return null
  try {
    return JSON.parse(text.slice(start + label.length + 2).trim())
  } catch {
    return null
  }
}

/** A visible pseudo-translation: locale marker plus the source, tags untouched. */
function scriptTranslations(text: string) {
  const locale = field(text, 'Target locale') || 'xx'
  const items = (jsonAfter(text, 'Items') as Array<{ id: string; text: string }> | null) ?? []
  const language = locale.split('-')[0]!.toUpperCase()
  return { translations: items.map((item) => ({ id: item.id, text: `${language}: ${item.text}` })) }
}

/** Plain headlines built from the brief's first sentence and each slide's topic; no numbers. */
function scriptCopySuggestions(text: string, system: string) {
  const slides = (jsonAfter(text, 'Slides') as Array<{ id: string; topic: string; currentHeadline: string }> | null) ?? []
  const brief = text.match(/Product brief:\n([^\n]+)/)?.[1] ?? ''
  const count = Number(system.match(/Give (\d+) distinct variants/)?.[1] ?? 2)
  const words = (value: string) => value.replace(/[0-9]/g, '').split(/\s+/).filter(Boolean)
  return {
    slides: slides.map((slide) => ({
      id: slide.id,
      suggestions: Array.from({ length: count }, (_, index) => {
        const source = words(slide.topic || slide.currentHeadline || brief)
        const headline = clip(source.slice(index, index + 4).join(' ') || 'Do more with less effort', 32)
        return {
          headline: headline.charAt(0).toUpperCase() + headline.slice(1),
          rationale: 'Built only from the words in your brief and slide topic.',
          subheadline: clip(firstSentence(brief.replace(/[0-9]/g, '')), 60),
        }
      }),
    })),
  }
}

export function createScriptedModel(modelId: string): LanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      // Credential-free E2E protocol fixture, not an audio recognition model.
      if (systemText(options).startsWith('Transcribe this voice memo faithfully')) {
        return respond([{type:'text',text:'Today we shipped a small improvement. Check the measured results before adding numbers.'}])
      }
      const names = toolNames(options)
      const { calls, results, text } = readPrompt(options)
      const submit = SUBMIT_TOOLS.find((name) => names.includes(name))
      if (submit) {
        // One submission per run; after it, finish with a sentence.
        if (results.some((result) => result.toolName === submit)) {
          return respond([{ text: 'Submitted.', type: 'text' }])
        }
        const input =
          submit === 'submitGridLines'
            ? { lines: ['Scripted suggestion one', 'Scripted suggestion two'] }
            : submit === 'submitRefinement'
            ? scriptRefinement(text, systemText(options))
            : submit === 'submitSpec'
            ? scriptSpec(text)
            : submit === 'submitPlan'
              ? scriptPlan(text)
              : submit === 'saveLaunchCopy'
                ? scriptCopy(text)
                : submit === 'submitCritique'
                  ? { brand: 5, issues: [], legibility: 5, specFidelity: 5, verdict: 'pass' }
                  : submit === 'submitLinkCopy'
                    ? scriptLinkCopy(text)
                    : submit === 'submitCaptions'
                      ? scriptCaptions(text)
                      : submit === 'submitTranslations'
                        ? scriptTranslations(text)
                        : submit === 'submitCopySuggestions'
                          ? scriptCopySuggestions(text, systemText(options))
                          : scriptRevision(text, toolProperties(options, 'proposeRevision'))
        return respond(toolCalls([{ input, toolName: submit }]))
      }
      if (names.includes('showVariants') && !results.some((result) => result.toolName === 'showVariants')) {
        const words = { five: 5, four: 4, six: 6, three: 3, two: 2 } as Record<string, number>
        const asked = text.match(/\b(\d|two|three|four|five|six)\s+(?:versions|variants|options|alternatives)\b/i)
        if (asked) {
          const count = Number(asked[1]) || words[asked[1]!.toLowerCase()] || 4
          return respond(toolCalls([{ input: { count, instruction: '' }, toolName: 'showVariants' }]))
        }
      }
      if (names.includes('proposeVariant')) {
        const done = results.filter((result) => result.toolName === 'proposeVariant').length
        const next = done === 0 ? scriptVariants(text, 0) : []
        if (next.length > 0) return respond(toolCalls(next))
        return respond([{ text: 'Proposed the versions.', type: 'text' }])
      }
      if (names.includes('captureProductPage')) {
        const next = scriptVisuals(text, results, calls)
        if (next && next.length > 0) return respond(toolCalls(next))
        return respond([
          { text: 'Captured the product and made the planned product shots.', type: 'text' },
        ])
      }
      if (names.includes('createCampaign')) {
        return respond(scriptConversation(options, names, calls, results))
      }
      if (names.includes('requestApproval')) {
        const next = scriptApproval(text, names, calls)
        if (next) return respond(toolCalls(next))
        return respond([{ text: 'Submitted the posts for review.', type: 'text' }])
      }
      return respond([{ text: 'Done.', type: 'text' }])
    },
    modelId: `scripted/${modelId}`,
    provider: 'scripted',
  })
}
