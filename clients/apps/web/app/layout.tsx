import { AppThemeProvider } from '@/components/platform-shell/AppThemeProvider'
import type { Metadata, Viewport } from 'next'
import { OG_DEFAULTS, SITE_URL } from '@/lib/seo/metadata'
import {
  Geist,
  Geist_Mono,
  Caveat,
  Inter,
  Poppins,
  Space_Grotesk,
  Outfit,
  Plus_Jakarta_Sans,
  DM_Sans,
  Playfair_Display,
  Lora,
  Libre_Baskerville,
  Bebas_Neue,
  Righteous,
  Pacifico,
  Dancing_Script,
  JetBrains_Mono,
  Fira_Code,
  Sora,
  Manrope,
  Raleway,
  Oswald,
  Montserrat,
  Lexend,
  Work_Sans,
  Urbanist,
  Albert_Sans,
} from 'next/font/google'
import './globals.css'
import { AppToaster } from '@/components/platform-shell/AppToaster'
import { HydrationMarker } from '@/components/platform-shell/HydrationMarker'
import { QueryProvider } from '@/lib/query-client'
import { TRPCReactProvider } from '@/lib/trpc/provider'
import { GlobalDropZone } from '@/components/GlobalDropZone'
import { PathTracker } from '@/components/landing/GoBackButton'
import { AdFreeRouteLinks } from '@/components/AdFreeRouteLinks'
import { getRootJsonLd } from '@/lib/seo/json-ld'
import { ADSENSE_CLIENT } from '@/lib/adsense'
import { ConsentBanner } from '@/components/ConsentBanner'
import { PRODUCT_FACTS, atLeast } from '@/lib/seo/product-facts'
import { installDeploymentRecovery } from '@/lib/platform/deployment-recovery'

// System UI fonts
const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

// The UI face: one variable Inter (100–900) with the optical size axis.
const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  axes: ['opsz'],
  display: 'swap',
})

const poppins = Poppins({
  variable: '--font-poppins',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const spaceGrotesk = Space_Grotesk({
  variable: '--font-space-grotesk',
  preload: false,
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
})

const outfit = Outfit({
  variable: '--font-outfit',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const plusJakartaSans = Plus_Jakarta_Sans({
  variable: '--font-plus-jakarta-sans',
  preload: false,
  subsets: ['latin'],
  weight: ['200', '300', '400', '500', '600', '700', '800'],
})

const dmSans = DM_Sans({
  variable: '--font-dm-sans',
  preload: false,
  subsets: ['latin'],
  weight: 'variable',
})

const sora = Sora({
  variable: '--font-sora',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800'],
})

const manrope = Manrope({
  variable: '--font-manrope',
  preload: false,
  subsets: ['latin'],
  weight: ['200', '300', '400', '500', '600', '700', '800'],
})

const raleway = Raleway({
  variable: '--font-raleway',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const montserrat = Montserrat({
  variable: '--font-montserrat',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const lexend = Lexend({
  variable: '--font-lexend',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const workSans = Work_Sans({
  variable: '--font-work-sans',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const urbanist = Urbanist({
  variable: '--font-urbanist',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

const albertSans = Albert_Sans({
  variable: '--font-albert-sans',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
})

// Display/Condensed fonts
const oswald = Oswald({
  variable: '--font-oswald',
  preload: false,
  subsets: ['latin'],
  weight: ['200', '300', '400', '500', '600', '700'],
})

const bebasNeue = Bebas_Neue({
  variable: '--font-bebas-neue',
  preload: false,
  subsets: ['latin'],
  weight: ['400'],
})

const righteous = Righteous({
  variable: '--font-righteous',
  preload: false,
  subsets: ['latin'],
  weight: ['400'],
})

// Serif fonts
const playfairDisplay = Playfair_Display({
  variable: '--font-playfair-display',
  preload: false,
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800', '900'],
})

const lora = Lora({
  variable: '--font-lora',
  preload: false,
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
})

const libreBaskerville = Libre_Baskerville({
  variable: '--font-libre-baskerville',
  preload: false,
  subsets: ['latin'],
  weight: ['400', '700'],
})

// Handwriting/Script fonts
const caveat = Caveat({
  variable: '--font-caveat',
  preload: false,
  subsets: ['latin'],
})

const pacifico = Pacifico({
  variable: '--font-pacifico',
  preload: false,
  subsets: ['latin'],
  weight: ['400'],
})

const dancingScript = Dancing_Script({
  variable: '--font-dancing-script',
  preload: false,
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
})

// Monospace fonts
const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  preload: false,
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800'],
})

const firaCode = Fira_Code({
  variable: '--font-fira-code',
  preload: false,
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
})

// Combine all font variables
const fontVariables = [
  geistSans.variable,
  geistMono.variable,
  inter.variable,
  poppins.variable,
  spaceGrotesk.variable,
  outfit.variable,
  plusJakartaSans.variable,
  dmSans.variable,
  sora.variable,
  manrope.variable,
  raleway.variable,
  montserrat.variable,
  lexend.variable,
  workSans.variable,
  urbanist.variable,
  albertSans.variable,
  oswald.variable,
  bebasNeue.variable,
  righteous.variable,
  playfairDisplay.variable,
  lora.variable,
  libreBaskerville.variable,
  caveat.variable,
  pacifico.variable,
  dancingScript.variable,
  jetbrainsMono.variable,
  firaCode.variable,
].join(' ')

export const metadata: Metadata = {
  applicationName: 'Shots',
  title: {
    default: 'Shots: Turn every release into a launch',
    template: '%s | Shots',
  },
  // Add your Google Search Console verification code here
  // Get it from: https://search.google.com/search-console
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION || '',
    other: { 'msvalidate.01': 'A3B8CB50BBD78710971A13FA3EE1E544' },
    // yandex: "your-yandex-verification",
  },
  description:
    'Shots turns every release into a cited launch brief, on-brand visuals, and posts you approve. Every plan includes a screenshot editor.',
  abstract: 'Turn every release into a launch campaign that a person approves.',
  keywords: [
    // Platform keywords
    'product launch platform',
    'release announcement tool',
    'launch campaign generator',
    'changelog to social posts',
    'GitHub release to social media',
    'AI launch copy with citations',
    'product marketing for developers',
    'feature announcement',
    // Primary keywords
    'screenshot editor online',
    'online screenshot editor',
    'screenshot beautifier',
    'screenshot editor',
    'shots',
    'image editor',
    'online image editor',
    // Competitor & alternative keywords
    'pika style alternative',
    'shots.so alternative',
    'screenshot mockup tool',
    'browser mockup generator',
    'window mockup generator',
    'screenshot wrapper',
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
    'best screenshot editor online',
    'screenshot editor without watermark',
    'screenshot editor online without watermark',
    'screenshot editor no download',
    'uizard screenshot editor alternative',
    'mockup generator',
    'mockup online generator',
    'mockup online editor',
    'mockup editor online',
    'mockup design online',
    'online mockup generator no watermark',
    'mockup generator without watermark',
    'app mockup generator',
    'website mockup generator',
    'website mockup generator from url',
    'laptop mockup generator',
    'product mockup generator',
    'online 3d mockup generator',
    'best mockup generator',
    'best online mockup generator',
    'mockup app',
    // Feature keywords
    'social media graphics maker',
    'image background editor',
    'screenshot animation maker',
    'browser frame screenshot',
    'screenshot with gradient background',
    'mac window screenshot mockup',
    // Use case keywords
    'product screenshot tool',
    'SaaS screenshot maker',
    'app screenshot maker',
    'developer portfolio images',
    'Twitter card generator',
    'Instagram post creator',
    'LinkedIn banner maker',
    // Long-tail keywords
    'beautify screenshots online',
    'add background to screenshot',
    'screenshot to video converter',
    'screenshot padding and shadow tool',
    'screenshot border radius editor',
    'online screenshot beautifier',
    'image presentation maker',
  ],
  authors: [{ name: 'Shots', url: SITE_URL }],
  creator: 'Shots',
  publisher: 'Shots',
  metadataBase: new URL(SITE_URL),
  // Matches the Referrer-Policy header in next.config.ts.
  referrer: 'strict-origin-when-cross-origin',
  // Stops iOS from linking version numbers and dates as phone numbers.
  formatDetection: { telephone: false, address: false, email: false },
  appleWebApp: { title: 'Shots', statusBarStyle: 'default' },
  classification: 'Product launch software',
  archives: [`${SITE_URL}/changelog`],
  bookmarks: [`${SITE_URL}/landing`, `${SITE_URL}/pricing`, `${SITE_URL}/docs`],
  openGraph: {
    ...OG_DEFAULTS,
    title: 'Shots: Turn every release into a launch',
    description: `Shots turns every release into a cited launch brief, on-brand visuals, and posts you approve. Every plan includes a screenshot editor with ${atLeast(PRODUCT_FACTS.backgrounds)} backgrounds, 3D effects, and video export.`,
  },
  // Next fills the title, description and image from each page's Open Graph data.
  twitter: { card: 'summary_large_image' },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  icons: {
    icon: [
      { url: '/favicon.svg?v=10', type: 'image/svg+xml' },
      { url: '/favicon-96x96.png?v=10', type: 'image/png', sizes: '96x96' },
      { url: '/favicon-32x32.png?v=10', type: 'image/png', sizes: '32x32' },
      { url: '/favicon-16x16.png?v=10', type: 'image/png', sizes: '16x16' },
      { url: '/favicon.ico?v=10', sizes: '16x16 32x32 48x48' },
    ],
    shortcut: '/favicon.ico?v=10',
    apple: [{ url: '/apple-touch-icon.png?v=10', sizes: '180x180', type: 'image/png' }],
  },
  manifest: '/site.webmanifest',
  category: 'Marketing software',
  other: {
    'google-adsense-account': ADSENSE_CLIENT,
  },
}

export const viewport: Viewport = {
  // The page background of each theme (app/globals.css), for browser chrome and link previews.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f5f7' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: "cover",
  maximumScale: 5,
  userScalable: true,
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const rootJsonLd = getRootJsonLd()

  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(${installDeploymentRecovery.toString()})()` }} />
      </head>
      <link rel="alternate" type="text/markdown" href="/llms.txt" title="LLMs.txt" />
      <link
        rel="alternate"
        type="text/markdown"
        href="/llms-full.txt"
        title="LLMs Full Documentation"
      />
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(rootJsonLd) }}
        />
        <AppThemeProvider>
          <QueryProvider>
            <TRPCReactProvider>
              <GlobalDropZone>
                <PathTracker />
                <AdFreeRouteLinks />
                {children}
              </GlobalDropZone>
              <AppToaster />
              <ConsentBanner />
              <HydrationMarker />
            </TRPCReactProvider>
          </QueryProvider>
        </AppThemeProvider>
      </body>
    </html>
  )
}
