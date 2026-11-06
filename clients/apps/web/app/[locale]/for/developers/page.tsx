import { Metadata } from "next";
import Link from "next/link";
import { Navigation } from "@/components/landing/Navigation";
import { Footer } from "@/components/landing/Footer";
import { PRO_PLAN_OFFER } from "@/lib/seo/json-ld";
import { OG_DEFAULTS } from "@/lib/seo/metadata";
import { GithubLogoIcon as Github01Icon } from "@phosphor-icons/react/dist/ssr/GithubLogo"
import { CodeIcon as SourceCodeIcon } from "@phosphor-icons/react/dist/ssr/Code"
import { TerminalIcon as ComputerTerminal01Icon } from "@phosphor-icons/react/dist/ssr/Terminal"
import { FileCodeIcon as DocumentCodeIcon } from "@phosphor-icons/react/dist/ssr/FileCode"
import { StackIcon as Layers01Icon } from "@phosphor-icons/react/dist/ssr/Stack"
import { VideoIcon as Video01Icon } from "@phosphor-icons/react/dist/ssr/Video"
import { ArrowRightIcon as ArrowRight01Icon } from "@phosphor-icons/react/dist/ssr/ArrowRight";

export const metadata: Metadata = {
  title: "Screenshot Editor for Developers",
  description:
    "Beautify code screenshots, terminal output, and app UIs with backgrounds, 3D effects, and animations. Screenshot mockup tool for developers.",
  keywords: [
    "screenshot editor for developers",
    "code screenshot beautifier",
    "developer portfolio images",
    "github readme images",
    "terminal screenshot tool",
    "code snippet beautifier",
    "developer screenshot tool",
    "project showcase images",
    "github readme screenshot maker",
    "app store screenshot generator",
    "documentation screenshot tool",
    "code screenshot with background",
    "api screenshot beautifier",
    "open source project screenshots",
  ],
  openGraph: {
    ...OG_DEFAULTS,
    title: "Screenshot Editor for Developers",
    description:
      "Beautify code screenshots, terminal output, and project UIs. Browser-based tool for developers.",
    url: "/for/developers",
  },
  alternates: {
    canonical: "/for/developers",
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
    icon: Github01Icon,
    title: "GitHub README images",
    description:
      "Make your open source projects stand out with polished screenshots in README files. Add backgrounds and shadows to app screenshots that show off your work at its best.",
  },
  {
    icon: SourceCodeIcon,
    title: "Code snippet sharing",
    description:
      "Share code screenshots on Twitter, LinkedIn, or dev blogs, with gradient backgrounds and device frames.",
  },
  {
    icon: ComputerTerminal01Icon,
    title: "Terminal & CLI output",
    description:
      "Turn raw terminal output into clean visuals for documentation and tutorials. Add macOS window frames and subtle shadows.",
  },
  {
    icon: DocumentCodeIcon,
    title: "Technical blog posts",
    description:
      "Create hero images and inline screenshots for dev.to, Hashnode, or your personal blog. Consistent styling across all your content.",
  },
  {
    icon: Layers01Icon,
    title: "Portfolio & case studies",
    description:
      "Present your projects in 3D perspective mockups.",
  },
  {
    icon: Video01Icon,
    title: "Demo videos & GIFs",
    description:
      "Create animated walkthroughs of your apps with zoom, pan, and transition effects. Export as MP4 or GIF for issue trackers and pull requests.",
  },
];

const workflows = [
  {
    title: "Paste from clipboard",
    description:
      "Take a screenshot with your OS shortcut, then Cmd+V directly into the editor. No saving files first.",
  },
  {
    title: "Drag & drop",
    description:
      "Drag any image file from your file manager straight onto the canvas. Supports PNG, JPG, WebP.",
  },
  {
    title: "One-click presets",
    description:
      "Pick a preset that matches your style. Dark mode gradients, minimal whites, or vibrant colors.",
  },
];

const reasons = [
  {
    title: "Open source",
    description:
      "Open source under Apache 2.0. Inspect the code, contribute, or self-host.",
  },
  {
    title: "Privacy first",
    description:
      "Editing runs in your browser. Imported images are not uploaded to edit them, and export compression returns the finished image without storing it.",
  },
  {
    title: "Fast & lightweight",
    description:
      "No heavy downloads or Electron apps. Just open a browser tab and start editing.",
  },
];

const featureLinks = [
  { href: "/features/screenshot-beautifier", label: "Screenshot Beautifier" },
  { href: "/features/animation-maker", label: "Animation Maker" },
  { href: "/features/3d-effects", label: "3D Effects" },
  { href: "/features/social-media-graphics", label: "Social Media Graphics" },
];

export default function ForDevelopersPage() {
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
            name: "For Developers",
            item: "https://shots.playbookmedia.io/for/developers",
          },
        ],
      },
      {
        "@type": "SoftwareApplication",
        name: "Shots for Developers",
        applicationCategory: "DesignApplication",
        operatingSystem: "Web Browser",
        description:
          "Screenshot editor built for developers. Beautify code screenshots, terminal output, and project UIs for READMEs, blogs, and portfolios.",
        offers: PRO_PLAN_OFFER,
        featureList: [
          "Code screenshot beautification",
          "Terminal window frames",
          "GitHub README images",
          "3D perspective mockups",
          "Animation and video export",
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
              Built for Developers
            </p>
            <h1
              className="mb-6 text-4xl font-semibold tracking-[-0.04em] text-foreground md:text-6xl"
              style={{ fontFamily: INTER }}
            >
              Screenshot editor for developers
            </h1>
            <p className="mx-auto mb-8 max-w-2xl text-lg text-muted-foreground md:text-xl">
              Add backgrounds, device frames, 3D effects, and animations to
              code, terminal, and app screenshots. Runs in your browser and is
              included in every Shots plan.
            </p>
            <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link href="/editor" className={ctaClassName}>
                Open Editor
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
                How developers use Shots
              </h2>
              <p className="mx-auto max-w-2xl text-muted-foreground">
                From README files to conference talks, make every screenshot
                count.
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
                Fits your workflow
              </h2>
              <p className="text-muted-foreground">
                No installs. The editor runs in your browser.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
              {workflows.map((w, i) => (
                <div key={w.title} className="text-center">
                  <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-md bg-primary text-base font-semibold text-primary-foreground">
                    {i + 1}
                  </div>
                  <h3
                    className="mb-2 text-lg font-semibold tracking-[-0.02em] text-foreground"
                    style={{ fontFamily: INTER }}
                  >
                    {w.title}
                  </h3>
                  <p className="text-sm text-muted-foreground">{w.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-border px-6 py-20">
          <div className="mx-auto max-w-4xl">
            <h2
              className="mb-12 text-center text-3xl font-semibold tracking-[-0.03em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Why developers choose Shots
            </h2>
            <div className="space-y-6">
              {reasons.map((reason) => (
                <div key={reason.title} className="flex gap-4">
                  <div className="mt-3 h-2 w-2 shrink-0 rounded-full bg-primary" />
                  <div>
                    <h3
                      className="mb-1 font-semibold tracking-[-0.02em] text-foreground"
                      style={{ fontFamily: INTER }}
                    >
                      {reason.title}
                    </h3>
                    <p className="text-muted-foreground">{reason.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-border px-6 py-16">
          <div className="mx-auto max-w-4xl">
            <h2
              className="mb-6 text-2xl font-semibold tracking-[-0.03em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Automate it from CI
            </h2>
            <p className="mb-4 text-muted-foreground">
              Parts of the workflow are also available over HTTP, with no API
              key. <code className="rounded bg-muted px-1.5 py-0.5 text-sm">POST /api/screenshot</code>{" "}
              captures a live URL as a PNG and{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-sm">POST /api/export</code>{" "}
              recompresses an image, which is enough to regenerate README and docs
              images on every release rather than redrawing them.
            </p>
            <p className="text-muted-foreground">
              Read the{" "}
              <Link href="/docs" className="underline underline-offset-4">
                API documentation
              </Link>{" "}
              for runnable examples and the error-code table, the{" "}
              <Link
                href="/docs/authentication"
                className="underline underline-offset-4"
              >
                authentication and rate limit notes
              </Link>
              , or pull the machine-readable{" "}
              <Link href="/openapi.json" className="underline underline-offset-4">
                OpenAPI 3.1 specification
              </Link>
              .
            </p>
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
              Ship better looking projects
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
