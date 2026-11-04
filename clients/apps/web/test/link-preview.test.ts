import assert from 'node:assert/strict'
import test from 'node:test'
import { linkPreviewSchema } from '@/lib/api/contracts/link-preview'
import { safeFetchText, safeProbe, type Transport } from '@/lib/launch/safe-fetch'
import { auditLinkPreview } from '@/lib/link-preview/audit'
import { parseLinkPreview, scoreLinkPreview, toMetaTagsHtml } from '@/lib/link-preview/metadata'
import { crawlerAccess, parseRobots, robotsAllows } from '@/lib/link-preview/robots'
import {
  applyEdits,
  markdownReport,
  NO_EDITS,
  recommendedHtml,
  recommendedJsonLd,
  recommendedNextMetadata,
} from '@/lib/link-preview/snippets'

const PAGE = `<!doctype html><html lang="en"><head>
  <meta charset="utf-8">
  <title>
    Ledgerly &amp; friends
  </title>
  <meta name="description" content='Invoices that send "themselves".'>
  <meta property="og:title" content="Ledgerly">
  <meta property="og:image" content="/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="//cdn.example/x.png">
  <meta name="al:ios:url" content="ledgerly://home">
  <link rel="canonical" href="https://ledgerly.example/">
  <link rel="Shortcut Icon" href="favicon.png">
  <script>document.write('<meta property="og:title" content="from script">')</script>
  <!-- <meta name="robots" content="noindex"> -->
  <meta-widget name="robots" content="custom element"></meta-widget>
  <meta name="theme-color" content="#0f766e">
  <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["WebSite","Thing"]}]}</script>
  <script type="application/ld+json">{ not json</script>
</head><body><svg><title>icon</title></svg></body></html>`

test('the parser reads title, Open Graph, and X tags, resolving relative URLs', () => {
  const preview = parseLinkPreview(PAGE, 'https://ledgerly.example/pricing/')
  assert.equal(preview.title, 'Ledgerly & friends')
  assert.equal(preview.description, 'Invoices that send "themselves".')
  assert.equal(preview.ogTitle, 'Ledgerly', 'tags inside scripts are not read')
  assert.equal(preview.ogImage, 'https://ledgerly.example/og.png')
  assert.equal(preview.twitterCard, 'summary_large_image', 'property= works for X tags')
  assert.equal(preview.twitterImage, 'https://cdn.example/x.png')
  assert.equal(preview.favicon, 'https://ledgerly.example/pricing/favicon.png')
  assert.equal(preview.canonical, 'https://ledgerly.example/')
  assert.equal(preview.language, 'en')
  assert.equal(preview.charset, 'utf-8')
  assert.equal(preview.robots, undefined, 'comments and custom elements are not tags')
  assert.equal(preview.themeColor, '#0f766e')
  assert.deepEqual(
    preview.jsonLd,
    ['Organization', 'WebSite', 'Thing'],
    'broken blocks are skipped'
  )
  const deepLink = preview.tags.find((tag) => tag.key === 'al:ios:url')
  assert.equal(deepLink?.value, 'ledgerly://home', 'meta content is not rewritten as a URL')
  assert.ok(linkPreviewSchema.safeParse(preview).success)
})

test('the score weighs the checks and the HTML export round-trips the tags', () => {
  const preview = parseLinkPreview(PAGE, 'https://ledgerly.example/')
  const { checks, score } = scoreLinkPreview(preview)
  assert.deepEqual(
    checks.map((check) => check.id),
    auditLinkPreview(preview).map((issue) => issue.id)
  )
  assert.equal(score, Math.max(0, 100 - checks.reduce((sum, check) => sum + check.weight, 0)))
  assert.ok(score > 0 && score < 100)
  assert.equal(scoreLinkPreview({ jsonLd: [], tags: [], url: 'https://x.example/' }).score, 0)

  const html = toMetaTagsHtml(preview)
  assert.match(html, /^<title>Ledgerly &amp; friends<\/title>/)
  assert.match(html, /<meta charset="utf-8">/)
  assert.match(html, /<meta property="og:image:width" content="1200">/)
  assert.match(
    html,
    /<meta name="description" content="Invoices that send &quot;themselves&quot;.">/
  )
  assert.match(html, /<link rel="canonical" href="https:\/\/ledgerly.example\/">/)
  const reparsed = parseLinkPreview(`<head>${html}</head>`, 'https://ledgerly.example/')
  assert.deepEqual(reparsed.tags, preview.tags)
})

test('the probe follows only public redirects and never reads the body', async () => {
  const requested: string[] = []
  const transport: Transport = async ({ url }) => {
    requested.push(url.toString())
    const routes: Record<string, { location?: string; status: number }> = {
      'https://public.example/robots.txt': { status: 200 },
      'https://public.example/old': { location: '/robots.txt', status: 301 },
      'https://public.example/sneaky': { location: 'http://169.254.169.254/', status: 302 },
    }
    const route = routes[url.toString()] ?? { status: 404 }
    return {
      body: {
        [Symbol.asyncIterator]: () => {
          throw new Error('the body was read')
        },
      },
      destroy: () => undefined,
      headers: { location: route.location },
      status: route.status,
    }
  }
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }]
  const options = { resolve, transport }
  assert.equal(await safeProbe('https://public.example/robots.txt', options), true)
  assert.equal(await safeProbe('https://public.example/old', options), true)
  assert.equal(await safeProbe('https://public.example/missing', options), false)
  assert.equal(await safeProbe('https://public.example/sneaky', options), false)
  assert.equal(await safeProbe('http://127.0.0.1/robots.txt', options), false)
  assert.ok(!requested.some((url) => url.includes('169.254') || url.includes('127.0.0.1')))
})

test('robots.txt is matched per crawler, by the longest rule, with wildcards', () => {
  const groups = parseRobots(`# comment
User-agent: *
Disallow: /private
Allow: /private/press$

User-agent: Twitterbot
User-agent: facebookexternalhit
Disallow: /

User-agent: LinkedInBot
Disallow: /*.pdf$
Disallow:
`)
  assert.deepEqual(robotsAllows(groups, 'Googlebot', '/pricing'), { allowed: true })
  assert.equal(robotsAllows(groups, 'Googlebot', '/private/x').allowed, false)
  assert.equal(
    robotsAllows(groups, 'Googlebot', '/private/press').allowed,
    true,
    'longer allow wins'
  )
  assert.equal(robotsAllows(groups, 'Googlebot', '/private/press/x').allowed, false, '$ anchors')
  assert.deepEqual(robotsAllows(groups, 'Twitterbot', '/'), { allowed: false, rule: 'Disallow: /' })
  assert.equal(
    robotsAllows(groups, 'LinkedInBot', '/private/x').allowed,
    true,
    'named group replaces *'
  )
  assert.equal(robotsAllows(groups, 'LinkedInBot', '/deck.pdf').allowed, false)
  const access = crawlerAccess('User-agent: Twitterbot\nDisallow: /', 'https://a.example/p?q=1')
  assert.equal(access.length, 8)
  assert.equal(access.find((entry) => entry.crawler === 'x')?.allowed, false)
  assert.equal(access.find((entry) => entry.crawler === 'facebook')?.allowed, true)
})

test('the audit names what breaks the preview and how to fix it', () => {
  const base = parseLinkPreview(PAGE, 'https://ledgerly.example/')
  const preview = {
    ...base,
    crawlers: crawlerAccess('User-agent: Twitterbot\nDisallow: /', base.url),
    images: [
      {
        bytes: 6 * 1024 * 1024,
        contentType: 'image/png',
        format: 'png',
        height: 800,
        url: base.ogImage!,
        width: 800,
      },
      { error: 'The source returned HTTP 404.', url: base.twitterImage! },
    ],
    response: {
      bytes: 900,
      contentType: 'text/html',
      durationMs: 4200,
      hops: [
        { status: 301, url: 'http://ledgerly.example/' },
        { status: 200, url: base.url },
      ],
      truncated: false,
    },
  }
  const ids = auditLinkPreview(preview).map((issue) => issue.id)
  for (const id of [
    'og-image-relative',
    'og-image-heavy',
    'og-image-ratio',
    'og-image-declared-size',
    'twitter-image-unreachable',
    'robots-x',
    'slow',
    'redirects',
    'title-short',
  ]) {
    assert.ok(ids.includes(id), `expected ${id} in ${ids.join(', ')}`)
  }
  assert.ok(!ids.includes('og-image-missing') && !ids.includes('theme-color-missing'))
  const severities = auditLinkPreview(preview).map((issue) => issue.severity)
  assert.deepEqual(
    severities,
    [...severities].sort(
      (a, b) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(b)
    )
  )
})

test('edits flow into every tag, and the snippets fill gaps with marked placeholders', () => {
  const preview = parseLinkPreview(PAGE, 'https://ledgerly.example/')
  assert.deepEqual(applyEdits(preview, NO_EDITS), preview)
  const edited = applyEdits(preview, {
    ...NO_EDITS,
    title: "Ledgerly's invoices",
    image: 'https://cdn.example/new.png',
  })
  assert.equal(edited.ogTitle, "Ledgerly's invoices")
  assert.equal(edited.twitterTitle, "Ledgerly's invoices")
  assert.equal(edited.twitterImage, 'https://cdn.example/new.png')

  const html = recommendedHtml(edited)
  assert.match(html, /<meta property="og:title" content="Ledgerly&#039;s invoices">/)
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/)
  assert.match(html, /<meta property="og:site_name" content="TODO: your brand name">/)
  const next = recommendedNextMetadata(edited)
  assert.match(next, /title: 'Ledgerly\\'s invoices',/)
  assert.match(next, /images: \[\{\n\s+url: 'https:\/\/cdn.example\/new.png',/)
  assert.doesNotMatch(next, /undefined/)

  const report = markdownReport(edited, 72, auditLinkPreview(edited))
  assert.match(report, /^# Link preview report: https:\/\/ledgerly.example\//)
  assert.match(report, /Score \*\*72\/100\*\*/)
})

test('the fetcher records each redirect hop on the way to the page', async () => {
  const transport: Transport = async ({ url }) => {
    const redirect = url.pathname === '/old'
    return {
      body: (async function* () {
        if (!redirect) yield Buffer.from('<title>New</title>')
      })(),
      destroy: () => undefined,
      headers: redirect
        ? { location: '/new' }
        : { 'content-type': 'text/html', 'x-robots-tag': 'noindex' },
      status: redirect ? 301 : 200,
    }
  }
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }]
  const page = await safeFetchText('https://public.example/old', { resolve, transport })
  assert.ok(page.ok)
  assert.deepEqual(page.hops, [
    { status: 301, url: 'https://public.example/old' },
    { status: 200, url: 'https://public.example/new' },
  ])
  assert.equal(page.headers?.['x-robots-tag'], 'noindex')
})

test('tracked links tag each channel and posts are counted the way each platform counts', async () => {
  const { CHANNELS, postLength, trackedLink } = await import('@/lib/link-preview/share')
  const url = 'https://ledgerly.example/pricing?plan=pro&utm_source=old'
  const tracked = new URL(trackedLink(url, 'linkedin', { campaign: 'Spring Launch', content: '' }))
  assert.equal(tracked.searchParams.get('plan'), 'pro')
  assert.equal(tracked.searchParams.get('utm_source'), 'linkedin')
  assert.equal(tracked.searchParams.get('utm_medium'), 'social')
  assert.equal(tracked.searchParams.get('utm_campaign'), 'Spring Launch')
  assert.equal(tracked.searchParams.has('utm_content'), false)
  assert.equal(
    new URL(trackedLink(url, 'email', { campaign: '', content: 'hero' })).searchParams.get(
      'utm_medium'
    ),
    'email'
  )

  const link = 'https://ledgerly.example/a-very-long-path/that-goes-on-and-on'
  assert.equal(postLength('Hello', 'x', link), 5 + 1 + 23, 'X adds the link at 23 characters')
  assert.equal(postLength(`Hello ${link}`, 'mastodon', link), 5 + 1 + 23)
  assert.equal(
    postLength('Hello 👋🏽', 'bluesky', link),
    7,
    'an emoji with a skin tone is one grapheme'
  )
  const intent = new URL(CHANNELS.x.intent!(link, 'New pricing'))
  assert.equal(intent.searchParams.get('url'), link)
  assert.equal(intent.searchParams.get('text'), 'New pricing')
})

const RICH = `<html lang="fr"><head>
  <title>Ledgerly · Invoices · Ledgerly</title>
  <meta name="description" content="Ledgerly · Invoices · Ledgerly">
  <meta property="og:type" content="article">
  <meta property="og:locale" content="en_US">
  <meta property="article:modified_time" content="last tuesday">
  <meta property="og:video" content="http://cdn.example/v.mp4">
  <meta name="twitter:card" content="player">
  <meta name="twitter:player" content="http://cdn.example/player">
  <meta property="al:android:url" content="ledgerly://home">
  <meta name="apple-itunes-app" content="app-argument=ledgerly://home">
  <link rel="alternate" hreflang="de" href="https://ledgerly.example/de/">
  <link rel="alternate" hreflang="english" href="https://ledgerly.example/en/">
  <link rel="icon" sizes="32x32" type="image/png" href="/icon-32.png">
  <link rel="alternate" type="application/json+oembed" href="/oembed?url=x">
  <link rel="canonical" href="http://ledgerly.example/">
</head></html>`

test('extra tags are read and audited: video, article, apps, languages, icons, copy', async () => {
  const { iconLinks, languageAlternates, oembedLink, videoMeta } =
    await import('@/lib/link-preview/extras')
  const preview = parseLinkPreview(RICH, 'https://ledgerly.example/')
  assert.equal(videoMeta(preview).ogVideo, 'http://cdn.example/v.mp4')
  assert.deepEqual(
    languageAlternates(preview).map((entry) => entry.hreflang),
    ['de', 'english']
  )
  assert.deepEqual(iconLinks(preview).icons[0], {
    href: 'https://ledgerly.example/icon-32.png',
    rel: 'icon',
    sizes: '32x32',
    type: 'image/png',
  })
  assert.equal(oembedLink(preview), 'https://ledgerly.example/oembed?url=x')
  assert.match(toMetaTagsHtml(preview), /<link rel="icon" sizes="32x32" type="image\/png" href=/)

  const ids = auditLinkPreview(preview).map((issue) => issue.id)
  for (const id of [
    'title-repeated',
    'description-is-title',
    'locale-mismatch',
    'canonical-insecure',
    'twitter-player-insecure',
    'twitter-player-size',
    'og-video-type',
    'og-video-insecure',
    'article-published-missing',
    'article:modified_time-invalid',
    'al-android-package',
    'smart-banner-id',
    'hreflang-invalid',
    'hreflang-x-default',
    'hreflang-self',
    'apple-touch-icon',
    'manifest-missing',
  ]) {
    assert.ok(ids.includes(id), `expected ${id}`)
  }
})

test('framework snippets and JSON-LD carry the same tags safely', async () => {
  const { recommendedJsonLd, recommendedNuxt, recommendedReactRouter, recommendedSvelteKit } =
    await import('@/lib/link-preview/snippets')
  const preview = parseLinkPreview(
    `<head><title>A </script> title</title><meta property="og:type" content="article"><meta property="og:image" content="https://x.example/og.png"></head>`,
    'https://ledgerly.example/post'
  )
  const jsonLd = recommendedJsonLd(preview)
  assert.equal(jsonLd.match(/<\/script>/g)?.length, 1, 'only the closing tag ends the script')
  const data = JSON.parse(jsonLd.replace(/^<script[^>]*>|<\/script>\s*$/g, ''))
  assert.equal(data['@graph'][0]['@type'], 'Article')
  assert.equal(data['@graph'][0].datePublished, 'TODO: 2026-10-16T09:00:00Z')
  assert.match(recommendedNuxt(preview), /ogImage: 'https:\/\/x.example\/og.png',/)
  assert.equal(recommendedNuxt(preview).match(/<\/script>/g)?.length, 1)
  assert.match(
    recommendedReactRouter(preview),
    /\{ property: 'og:image', content: 'https:\/\/x.example\/og.png' \},/
  )
  assert.match(recommendedSvelteKit(preview), /^<svelte:head>\n {2}<title>/)
})

test('sitemaps, history, duplicates, and CI scripts', async () => {
  const { parseSitemap, robotsSitemaps } = await import('@/lib/link-preview/sitemap')
  assert.deepEqual(
    parseSitemap(
      `<urlset><url><loc> https://a.example/?a=1&amp;b=2 </loc></url><url><loc><![CDATA[https://a.example/b]]></loc></url><url><loc>ftp://nope</loc></url></urlset>`
    ),
    { index: false, locs: ['https://a.example/?a=1&b=2', 'https://a.example/b'] }
  )
  assert.equal(
    parseSitemap(
      '<sitemapindex><sitemap><loc>https://a.example/s1.xml</loc></sitemap></sitemapindex>'
    ).index,
    true
  )
  assert.deepEqual(
    robotsSitemaps('User-agent: *\nSitemap: https://a.example/sitemap_index.xml\n'),
    ['https://a.example/sitemap_index.xml']
  )

  const { snapshotChanges, snapshotOf } = await import('@/lib/link-preview/history')
  const before = parseLinkPreview(PAGE, 'https://ledgerly.example/')
  const after = { ...before, ogImage: 'https://ledgerly.example/new.png', title: 'Ledgerly' }
  const changes = snapshotChanges(snapshotOf(before, 70, []), snapshotOf(after, 75, []))
  assert.deepEqual(
    changes.map((change) => change.label),
    ['Title', 'og:image']
  )
  assert.equal(changes[1]!.after, 'https://ledgerly.example/new.png')

  const { duplicateGroups } = await import('@/lib/link-preview/insights')
  const groups = duplicateGroups([
    { preview: before, url: 'https://ledgerly.example/a' },
    { preview: before, url: 'https://ledgerly.example/b' },
    { preview: after, url: 'https://ledgerly.example/c' },
  ])
  assert.deepEqual(
    groups.find((group) => group.field === 'title')?.urls,
    ['https://ledgerly.example/a', 'https://ledgerly.example/b', 'https://ledgerly.example/c'],
    'og:title is shared by all three'
  )
  assert.equal(groups.find((group) => group.field === 'image')?.urls.length, 2)

  const { githubActionsSnippet, nodeSnippet } = await import('@/lib/link-preview/automation')
  const options = {
    apiOrigin: 'https://shots.playbookmedia.io',
    failOnErrors: true,
    minScore: 80,
    urls: ["https://a.example/it's"],
  }
  const workflow = githubActionsSnippet(options)
  assert.match(workflow, /for url in 'https:\/\/a.example\/it'\\''s'; do/)
  assert.match(workflow, /-lt 80 \] \|\| \[ "\$errors" -gt 0 \]/)
  assert.match(workflow, /\$\{\{ secrets.SCREENSHOT_STUDIO_API_KEY \}\}/)
  assert.match(
    nodeSnippet({ ...options, failOnErrors: false }),
    /if \(report.score < 80\) failed = true/
  )
})

test('bot challenges are recognized and JavaScript-only tags are found', async () => {
  const { detectChallenge } = await import('@/lib/link-preview/crawlers')
  assert.equal(
    detectChallenge(403, { server: 'cloudflare' }, '<html><head><title>Just a moment...</title>'),
    'Cloudflare challenge'
  )
  assert.equal(detectChallenge(200, { 'cf-mitigated': 'challenge' }, ''), 'Cloudflare challenge')
  assert.equal(
    detectChallenge(403, {}, '<script src="https://ct.captcha-delivery.com/c.js">'),
    'DataDome'
  )
  assert.equal(detectChallenge(200, { server: 'cloudflare' }, '<title>Ledgerly</title>'), undefined)

  const { scriptDifferences } = await import('@/lib/link-preview/javascript')
  const raw = parseLinkPreview('<head><title>Loading…</title></head>', 'https://app.example/')
  const changes = scriptDifferences(raw, {
    ogImage: 'https://app.example/og.png',
    ogTitle: 'Ledgerly',
    tagCount: 12,
    title: 'Ledgerly · Invoices',
  })
  assert.deepEqual(
    changes.map(({ change, label }) => [label, change]),
    [
      ['Title', 'changed'],
      ['og:title', 'added'],
      ['og:image', 'added'],
    ]
  )
})

test('broken link targets and dropped UTM tags are reported', () => {
  const base = parseLinkPreview(PAGE, 'https://ledgerly.example/')
  const ids = auditLinkPreview({
    ...base,
    targets: [
      { kind: 'canonical', status: 404, url: 'https://ledgerly.example/old' },
      {
        finalUrl: 'https://ledgerly.example/home',
        kind: 'og:url',
        status: 200,
        url: 'https://ledgerly.example/',
      },
    ],
    tracking: {
      finalUrl: 'https://ledgerly.example/',
      kept: false,
      url: 'https://ledgerly.example/?utm_source=screenshot-studio',
    },
  }).map((issue) => issue.id)
  assert.ok(ids.includes('canonical-broken'))
  assert.ok(ids.includes('og-url-redirects'))
  assert.ok(ids.includes('tracking-dropped'))
})

test('the publishing gate reads each link in a post and blocks broken previews', async () => {
  const { linksInText } = await import('@/lib/link-preview/share')
  assert.deepEqual(
    linksInText(
      'New pricing → ledgerly.com/pricing. Docs: https://docs.ledgerly.io/start). Mail hi@ledgerly.com. Built with Node.js'
    ),
    ['https://ledgerly.com/pricing', 'https://docs.ledgerly.io/start']
  )
  const { postLinkProblems } = await import('@/lib/link-preview/gate')
  const good = parseLinkPreview(
    `<head><title>Ledgerly pricing for growing teams</title><meta property="og:image" content="https://ledgerly.example/og.png"><meta name="twitter:card" content="summary_large_image"></head>`,
    'https://ledgerly.example/pricing'
  )
  const read: Parameters<typeof postLinkProblems>[1] = async (url) =>
    url.includes('pricing')
      ? { ok: true, preview: good }
      : url.includes('docs')
        ? { ok: true, preview: parseLinkPreview('<head></head>', url) }
        : { ok: false, reason: 'The source returned HTTP 404.' }
  assert.deepEqual(await postLinkProblems('See ledgerly.com/pricing', read), [])
  const problems = await postLinkProblems('Docs at docs.ledgerly.io and gone.ledgerly.com/x', read)
  assert.equal(problems.length, 2)
  assert.match(problems[0]!, /^https:\/\/docs.ledgerly.io\/: The page has no <title>; No og:image/)
  assert.match(problems[1]!, /could not be read: The source returned HTTP 404/)
})

test('the crawler fetch keeps error statuses, and resolve reports where a link ends', async () => {
  const { safeFetchPage, safeResolve } = await import('@/lib/launch/safe-fetch')
  const transport: Transport = async ({ url }) => ({
    body: (async function* () {
      yield Buffer.from(url.pathname === '/blocked' ? '<title>Just a moment...</title>' : 'ok')
    })(),
    destroy: () => undefined,
    headers:
      url.pathname === '/old' ? { location: '/new?utm_source=x' } : { 'content-type': 'text/html' },
    status: url.pathname === '/blocked' ? 403 : url.pathname === '/old' ? 301 : 200,
  })
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }]
  const blocked = await safeFetchPage('https://public.example/blocked', { resolve, transport })
  assert.ok(blocked.ok && blocked.status === 403 && blocked.body.includes('Just a moment'))
  const resolved = await safeResolve('https://public.example/old', { resolve, transport })
  assert.ok(resolved.ok)
  assert.equal(resolved.url, 'https://public.example/new?utm_source=x')
  assert.equal(resolved.status, 200)
})

test('errors score below suggestions and every deduction is an audit finding', () => {
  const good = {
    ...parseLinkPreview(
      PAGE.replace('content="/og.png"', 'content="https://ledgerly.example/og.png"'),
      'https://ledgerly.example/'
    ),
    title: 'Ledgerly makes invoicing simple for teams',
    description: 'Simple invoicing for teams, with automatic reminders and clear payment tracking.',
    twitterCard: 'summary_large_image',
    canonical: 'https://ledgerly.example/',
    viewport: 'width=device-width',
    ogDescription: 'Automatic invoicing for teams.',
    ogImageAlt: 'An invoice',
    twitterImageAlt: 'An invoice',
  }
  const broken = {
    ...good,
    tracking: { url: good.url, finalUrl: good.url, kept: false },
    targets: [
      { kind: 'canonical' as const, url: good.url, finalUrl: `${good.url}home`, status: 200 },
    ],
  }
  assert.ok(
    auditLinkPreview(good).every((issue) => issue.severity === 'info'),
    JSON.stringify(auditLinkPreview(good))
  )
  assert.ok(scoreLinkPreview(broken).score < scoreLinkPreview(good).score)
  const checks = scoreLinkPreview(broken).checks
  assert.equal(checks.find((check) => check.id === 'tracking-dropped')?.severity, 'error')
  assert.equal(checks.find((check) => check.id === 'canonical-redirects')?.passed, false)
  assert.deepEqual(
    checks.map((check) => check.id),
    auditLinkPreview(broken).map((issue) => issue.id)
  )
})

test('URL lists preserve lines, reject malformed inputs, and keep query punctuation', async () => {
  const { normalizeUrl, parseUrlLines } = await import('@/components/link-preview/client')
  const parsed = parseUrlLines('vercel.com\r\nnot a url\nlinear.app/path?x=a,b\nvercel.com')
  assert.deepEqual(parsed.urls, ['https://vercel.com/', 'https://linear.app/path?x=a,b'])
  assert.deepEqual(parsed.invalid, ['not a url'])
  for (const value of ['not a url', 'javascript:alert(1)', 'foo', 'https://user:pass@example.com'])
    assert.equal(normalizeUrl(value), null)
  assert.equal(normalizeUrl('localhost:3000'), 'https://localhost:3000/')
})

test('NAV-03: a finished check keeps a safe way back and the brand, never an external one', async () => {
  const { checkAddress } = await import('@/components/link-preview/client')
  const opened = `https://shots.test/publish/link-checks?returnTo=${encodeURIComponent('/campaigns/deliveries?set=brand')}&set=brand&url=old`
  const address = new URL(checkAddress(opened, 'https://linear.app/', 'facebook'))
  assert.equal(address.pathname, '/publish/link-checks')
  assert.equal(address.searchParams.get('returnTo'), '/campaigns/deliveries?set=brand')
  assert.equal(address.searchParams.get('set'), 'brand')
  assert.equal(address.searchParams.get('url'), 'https://linear.app/')
  assert.equal(address.searchParams.get('agent'), 'facebook')
  for (const unsafe of ['https://evil.test/', '//evil.test/', '/\\evil.test'])
    assert.equal(
      new URL(
        checkAddress(
          `https://shots.test/publish/link-checks?returnTo=${encodeURIComponent(unsafe)}`,
          'https://linear.app/',
          'default'
        )
      ).search,
      `?url=${encodeURIComponent('https://linear.app/')}`
    )
})

test('invalid edited images are reported and never exported into snippets', async () => {
  const { isHttpUrl } = await import('@/lib/link-preview/urls')
  for (const image of [
    'javascript:alert(1)',
    'https://',
    'data:image/png;base64,abc',
    'https://a b/x',
  ]) {
    assert.equal(isHttpUrl(image), false)
    const edited = applyEdits(parseLinkPreview(PAGE, 'https://ledgerly.example/'), {
      ...NO_EDITS,
      image,
    })
    assert.ok(auditLinkPreview(edited).some((issue) => issue.id === 'og-image-invalid'))
    assert.ok(!recommendedJsonLd(edited).includes(JSON.stringify(image)))
    assert.ok(!recommendedHtml(edited).includes(`content="${image}"`))
  }
  assert.equal(isHttpUrl('https://github.com/fluidicon.png'), true)
})

test('declared sitemaps are checked before the conventional path', async () => {
  const { discoverSitemap } = await import('@/lib/link-preview/sitemap')
  const calls: string[] = []
  const probe = async (url: string) => {
    calls.push(url)
    return true
  }
  assert.equal(
    await discoverSitemap(
      'Sitemap: https://github.com/sitemap_marketing.xml',
      'https://github.com',
      probe
    ),
    'https://github.com/sitemap_marketing.xml'
  )
  assert.deepEqual(calls, ['https://github.com/sitemap_marketing.xml'])
  assert.equal(
    await discoverSitemap(
      'Sitemap: https://example.com/dead.xml',
      'https://example.com',
      async (url) => url.endsWith('/sitemap.xml')
    ),
    'https://example.com/sitemap.xml'
  )
  assert.equal(await discoverSitemap('', 'https://example.com', async () => false), undefined)
})

test('share tags preserve the entered values and character counters handle emoji', async () => {
  const { trackedLink, postLength } = await import('@/lib/link-preview/share')
  const { characterCount, xCharacterCount } = await import('@/lib/link-preview/text')
  const url = 'https://example.com/'
  const tracked = new URL(
    trackedLink(url, 'x', { campaign: 'Fall Launch & Promo #1', content: 'hero/v2?x=1' })
  )
  assert.equal(tracked.searchParams.get('utm_campaign'), 'Fall Launch & Promo #1')
  assert.equal(tracked.searchParams.get('utm_content'), 'hero/v2?x=1')
  assert.equal(characterCount('🚀é'), 2)
  for (const emoji of ['🚀', '👋🏽', '👨‍👩‍👧‍👦', '🇺🇸', '1️⃣']) assert.equal(xCharacterCount(emoji), 2)
  assert.equal(xCharacterCount('中文'), 4)
  assert.equal(xCharacterCount('é'), 1)
  assert.equal(postLength('🚀', 'x', url), 2 + 1 + 23)
  assert.equal(postLength('', 'x', url), 23)
})
