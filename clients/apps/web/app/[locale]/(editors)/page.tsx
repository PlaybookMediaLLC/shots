import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { permanentRedirect, redirect } from 'next/navigation'
import {
  getLocalizedPath,
  getPageAccess,
  unpaidLandingPath,
  upgradePath,
} from '@/lib/auth/page-access'
import { STORE_SCREENSHOTS } from '@/lib/platform/navigation'
import { OG_DEFAULTS } from '@/lib/seo/metadata'

export const metadata: Metadata = {
  title: 'Free Screenshot Editor & Mockup Maker',
  description:
    'Screenshot editor and mockup maker for product marketing teams. Add browser mockups, 3D effects, animations, and brand styling to your screenshots.',
  keywords: [
    'screenshot editor online free',
    'free screenshot editor',
    'online image editor',
    'screenshot beautifier online',
    'screenshot mockup tool',
    'pika style alternative',
    'shots.so alternative',
    'browser mockup generator',
    'safari browser mockup',
    'chrome browser mockup',
    'browser frame screenshot',
    'screenshot wrapper tool',
    'add background to screenshot free',
    'tweet to screenshot',
    'code snippet screenshot',
    'code to image generator',
    'mockup screenshot',
    'mockup online',
    'mockup screen',
    'mockups ui',
    'mockup ui ux',
    'app mockup generator',
    'ui mockup generator',
    'shots app alternative',
    'shots net alternative',
    'moqups alternative',
    'previewed app alternative',
    'appshots alternative',
    'goodmockups alternative',
    'mockup me alternative',
    'screenshot editor online free',
    'best screenshot editor online',
    'screenshot editor without watermark',
    'screenshot editor online free without watermark',
    'screenshot editor no download',
    'uizard screenshot editor alternative',
    'mockup generator',
    'free mockup generator',
    'mockup generator free',
    'mockup online generator',
    'mockup online editor',
    'mockup editor online free',
    'mockup design online',
    'mockup free online',
    'online mockup generator no watermark',
    'free mockup generator without watermark',
    'app mockup generator',
    'website mockup generator',
    'free website mockup generator',
    'website mockup generator from url',
    'laptop mockup generator',
    'product mockup generator',
    'free online 3d mockup generator',
    'best mockup generator',
    'best online mockup generator',
    'mockup app',
  ],
  alternates: {
    canonical: '/',
  },
  openGraph: {
    ...OG_DEFAULTS,
    title: 'Shots - Free Screenshot Editor & Mockup Maker',
    description:
      'Free screenshot editor online — add backgrounds, shadows, 3D effects, and animations. Export as PNG, JPG, or video.',
    url: '/',
  },
}

type EditorPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
  params: Promise<{ locale: string }>
}

export default async function EditorPage({ params, searchParams }: EditorPageProps) {
  const [{ locale }, requestHeaders] = await Promise.all([params, headers()])
  const query = await searchParams
  if (typeof query.new === 'string') redirect(getLocalizedPath(locale, `/write?${new URLSearchParams({new: query.new})}`))
  // The store studio moved to its own route; old links, with or without a project, land there.
  if (query.editor === 'app-store') {
    const project = typeof query.storeProject === 'string' ? `/${encodeURIComponent(query.storeProject)}` : ''
    permanentRedirect(getLocalizedPath(locale, `${STORE_SCREENSHOTS.href}${project}`))
  }
  const access = await getPageAccess(requestHeaders)
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query))
    for (const item of [value].flat()) if (item !== undefined) search.append(key, item)
  // Signed out, the bare address opens sign-in. Its query goes along, so
  // campaign (UTM) tags on shared links survive the redirect.
  if (!access) redirect(getLocalizedPath(locale, `/sign-in${search.size ? `?${search}` : ''}`))
  if (!access.hasOrganization) redirect(getLocalizedPath(locale, '/onboarding'))
  if (!access.isWorkspaceOperational) redirect(getLocalizedPath(locale, '/workspace'))
  if (!access.hasPaidPlan) {
    // Opening a project or the store studio names the editor on the plan page;
    // the bare address is just the way into the app.
    if (!access.hasBasicScheduling || search.size === 0) redirect(unpaidLandingPath(locale, access))
    redirect(upgradePath(locale, `/?${search}`))
  }

  // The editors layout renders the screenshot editor.
  return null
}
