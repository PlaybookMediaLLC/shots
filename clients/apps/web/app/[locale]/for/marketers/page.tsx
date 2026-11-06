import { Metadata } from "next";
import Link from "next/link";
import { Navigation } from "@/components/landing/Navigation";
import { Footer } from "@/components/landing/Footer";
import { PRO_PLAN_OFFER } from "@/lib/seo/json-ld";
import { OG_DEFAULTS } from "@/lib/seo/metadata";
import { MegaphoneIcon as Megaphone01Icon } from "@phosphor-icons/react/dist/ssr/Megaphone"
import { ShareIcon as Share01Icon } from "@phosphor-icons/react/dist/ssr/Share"
import { ChartLineUpIcon as ChartIncreaseIcon } from "@phosphor-icons/react/dist/ssr/ChartLineUp"
import { PresentationIcon as Presentation01Icon } from "@phosphor-icons/react/dist/ssr/Presentation"
import { ChartBarIcon as ChartHistogramIcon } from "@phosphor-icons/react/dist/ssr/ChartBar"
import { ImageIcon as Image01Icon } from "@phosphor-icons/react/dist/ssr/Image"
import { ArrowRightIcon as ArrowRight01Icon } from "@phosphor-icons/react/dist/ssr/ArrowRight";

export const metadata: Metadata = {
  title: "Screenshot Editor for Marketers",
  description:
    "Create product screenshots and mockups for landing pages, social media, and ads. Backgrounds, 3D effects, animations. No design skills needed.",
  keywords: [
    "screenshot editor for marketers",
    "product screenshot tool",
    "saas screenshot maker",
    "landing page images",
    "marketing screenshot editor",
    "ad creative tool",
    "product mockup generator",
    "social media marketing images",
    "product hunt launch images",
    "saas landing page hero image",
    "startup screenshot maker",
    "pitch deck screenshot tool",
    "feature announcement images",
    "comparison screenshot maker",
  ],
  openGraph: {
    ...OG_DEFAULTS,
    title: "Screenshot Editor for Marketers",
    description:
      "Create product screenshots for campaigns, landing pages, and social media. Included in every Shots plan.",
    url: "/for/marketers",
  },
  alternates: {
    canonical: "/for/marketers",
  },
};

const ctaClassName =
  "relative inline-flex items-center justify-center rounded-md border-0 bg-[var(--nav-cta-bg)] px-6 py-2.5 text-base font-medium text-[var(--nav-cta-fg)] shadow-none transition-[transform,box-shadow] duration-150 ease-out [text-shadow:var(--nav-cta-text-shadow)] hover:shadow-[var(--nav-cta-hover-shadow)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.97]";

const secondaryCtaClassName =
  "inline-flex items-center justify-center rounded-md px-6 py-2.5 text-base font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground active:scale-[0.99]";

const cardSurface =
  "rounded-2xl bg-card p-6 ring-1 ring-inset ring-border shadow-[var(--card-highlight-shadow)]";

const chipLinkClassName =
  "group flex items-center justify-between rounded-md bg-foreground/[0.04] px-4 py-3 text-sm font-medium text-foreground/90 ring-1 ring-border transition-colors hover:bg-foreground/[0.08] hover:text-foreground";

const INTER =
  "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const useCases = [
  {
    icon: Megaphone01Icon,
    title: "Landing page hero images",
    description:
      "Turn raw product screenshots into hero images. Add gradient backgrounds, shadows, and 3D perspective.",
  },
  {
    icon: Share01Icon,
    title: "Social media campaigns",
    description:
      "Create consistent, branded graphics for Twitter, LinkedIn, and Instagram. Perfect dimensions for every platform, optimized for engagement.",
  },
  {
    icon: ChartIncreaseIcon,
    title: "Ad creatives",
    description:
      "Build ad images from product screenshots, with backgrounds and angles instead of stock photos.",
  },
  {
    icon: Presentation01Icon,
    title: "Pitch decks & proposals",
    description:
      "Make product mockups for investor and client decks, with 3D perspective and device frames.",
  },
  {
    icon: ChartHistogramIcon,
    title: "Product announcements",
    description:
      "Announce new features with animated screenshots that show what the feature does.",
  },
  {
    icon: Image01Icon,
    title: "Email marketing",
    description:
      "Create clean product images for newsletters and drip campaigns. High-res exports that look sharp on any device.",
  },
];

const benefits = [
  {
    title: "No design skills required",
    description:
      "One-click presets handle the design work. Just upload a screenshot, pick a style, and export. Your whole team can create on-brand visuals.",
  },
  {
    title: "Consistent brand assets",
    description:
      "Use the same backgrounds, shadows, and styling across all your marketing materials. Build recognition with visual consistency.",
  },
  {
    title: "Faster than Figma or Canva",
    description:
      "Built for screenshots, so presets replace the layout work you would do by hand in Figma.",
  },
  {
    title: "Animated product demos",
    description:
      "Create animated product demos with zoom and pan effects. Export as video or GIF for social media posts.",
  },
];

const featureLinks = [
  { href: "/features/screenshot-beautifier", label: "Screenshot Beautifier" },
  { href: "/features/social-media-graphics", label: "Social Media Graphics" },
  { href: "/features/animation-maker", label: "Animation Maker" },
  { href: "/features/3d-effects", label: "3D Effects" },
];

export default function ForMarketersPage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Home",
            item: "https://shots.playbookmedia.io",
          },
          {
            "@type": "ListItem",
            position: 2,
            name: "For Marketers",
            item: "https://shots.playbookmedia.io/for/marketers",
          },
        ],
      },
      {
        "@type": "SoftwareApplication",
        name: "Shots for Marketers",
        applicationCategory: "DesignApplication",
        operatingSystem: "Web Browser",
        description:
          "Screenshot editor for marketers. Create product screenshots for landing pages, social media, and ad creatives without design skills.",
        offers: PRO_PLAN_OFFER,
        featureList: [
          "Product screenshot beautification",
          "Social media graphics",
          "Ad creative generation",
          "3D product mockups",
          "Animated demo videos",
          "Included in every Shots plan",
        ],
      },
    ],
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <Navigation />

      <main className="flex-1">
        <section className="px-6 pb-20 pt-32">
          <div className="mx-auto max-w-4xl text-center">
            <p
              className="mb-6 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground"
              style={{ fontFamily: INTER }}
            >
              Built for Marketers
            </p>
            <h1
              className="mb-6 text-4xl font-semibold tracking-[-0.04em] text-foreground md:text-6xl"
              style={{ fontFamily: INTER }}
            >
              Screenshot editor for marketers
            </h1>
            <p className="mx-auto mb-8 max-w-2xl text-lg text-muted-foreground md:text-xl">
              Create product visuals for landing pages, social
              media, and ad creatives. No design skills needed, no Figma
              required.
            </p>
            <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link href="/editor" className={ctaClassName}>
                Create Marketing Images
              </Link>
              <Link href="/features" className={secondaryCtaClassName}>
                See All Features
              </Link>
            </div>
          </div>
        </section>

        <section className="border-t border-border px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <div className="mb-16 text-center">
              <h2
                className="mb-4 text-3xl font-semibold tracking-[-0.03em] text-foreground md:text-4xl"
                style={{ fontFamily: INTER }}
              >
                How marketers use Shots
              </h2>
              <p className="mx-auto max-w-2xl text-muted-foreground">
                From landing page heroes to social campaigns, create visuals
                that convert.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
              {useCases.map((uc) => (
                <div key={uc.title} className={`${cardSurface} flex gap-4`}>
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.06] text-foreground ring-1 ring-inset ring-border">
                    <uc.icon size={20} />
                  </div>
                  <div>
                    <h3
                      className="mb-2 text-lg font-semibold tracking-[-0.02em] text-foreground"
                      style={{ fontFamily: INTER }}
                    >
                      {uc.title}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {uc.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-border px-6 py-20">
          <div className="mx-auto max-w-4xl">
            <div className="mb-16 text-center">
              <h2
                className="mb-4 text-3xl font-semibold tracking-[-0.03em] text-foreground md:text-4xl"
                style={{ fontFamily: INTER }}
              >
                Why marketing teams choose Shots
              </h2>
            </div>

            <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
              {benefits.map((b) => (
                <div key={b.title} className={cardSurface}>
                  <h3
                    className="mb-2 text-lg font-semibold tracking-[-0.02em] text-foreground"
                    style={{ fontFamily: INTER }}
                  >
                    {b.title}
                  </h3>
                  <p className="text-muted-foreground">{b.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-border px-6 py-16">
          <div className="mx-auto max-w-4xl">
            <h2
              className="mb-8 text-center text-2xl font-semibold tracking-[-0.03em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Explore features
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {featureLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={chipLinkClassName}
                >
                  <span>
                    {link.label}
                  </span>
                  <ArrowRight01Icon
                    size={14}
                    className="size-3.5 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground"
                  />
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-border px-6 py-20">
          <div className="mx-auto max-w-3xl text-center">
            <h2
              className="mb-4 text-3xl font-semibold tracking-[-0.03em] text-foreground md:text-4xl"
              style={{ fontFamily: INTER }}
            >
              Create marketing visuals from screenshots
            </h2>
            <p className="mb-8 text-lg text-muted-foreground">
              Included in every Shots plan. No watermarks.
            </p>
            <Link href="/editor" className={ctaClassName}>
              Open Editor
            </Link>
          </div>
        </section>
      </main>

      <Footer brandName="Shots" />
    </div>
  );
}
