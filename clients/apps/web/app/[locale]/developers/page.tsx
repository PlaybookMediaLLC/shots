import { Metadata } from "next";
import Link from "next/link";
import { Navigation } from "@/components/landing/Navigation";
import { Footer } from "@/components/landing/Footer";
import { OG_DEFAULTS } from "@/lib/seo/metadata";
import {
  INTER,
  cardSurface,
  codeBlockClassName,
  linkClassName,
} from "@/lib/seo/docs-shared";

export const metadata: Metadata = {
  title: "Shots Developer Portal",
  description:
    "Developer portal for Shots: API docs, OpenAPI 3.1 spec, authentication, rate limits, quickstart requests, and the open-source repository.",
  keywords: [
    "Shots developers",
    "Shots developer portal",
    "Shots API",
    "screenshot API quickstart",
    "screenshot OpenAPI spec",
  ],
  openGraph: {
    ...OG_DEFAULTS,
    title: "Shots Developer Portal",
    description:
      "API docs, OpenAPI spec, authentication, quickstart requests, and the open-source repository.",
    url: "/developers",
  },
  alternates: {
    canonical: "/developers",
  },
};

const RESOURCES = [
  {
    href: "/api-reference",
    label: "Interactive API reference",
    detail:
      "Explore every REST operation, copy examples, and send requests through Scalar.",
  },
  {
    href: "/docs",
    label: "API guides",
    detail:
      "Authentication, rate limits, request and response examples, and the error-code table.",
  },
  {
    href: "/openapi.json",
    label: "OpenAPI 3.1 specification",
    detail:
      "Machine-readable contract with operationIds, typed parameters, and response schemas.",
  },
  {
    href: "/docs/authentication",
    label: "Authentication and rate limits",
    detail: "Workspace API keys, signed-in sessions, and rate limits for every endpoint.",
  },
  {
    href: "/docs/agents",
    label: "AI agents (MCP)",
    detail: "Write and publish posts from Claude, Codex, OpenCode, ChatGPT, Cursor, and other agents through the Shots MCP server.",
  },
  {
    href: "/docs/automate",
    label: "Automate your launches",
    detail: "Turn a release, a merged pull request, or a deployment into campaign drafts for review.",
  },
  {
    href: "/llms.txt",
    label: "llms.txt",
    detail: "Markdown site overview for AI agents and LLM crawlers.",
  },
  {
    href: "/llms-full.txt",
    label: "llms-full.txt",
    detail: "Long-form Markdown reference covering features and the API.",
  },
];

const QUICKSTART = [
  {
    id: "publish",
    title: "1. Publish a post",
    body: "With a key that holds post:publish, one call writes a post and schedules or publishes it. Get account IDs from GET /api/v1/social-sets. A retry with the same Idempotency-Key never posts twice.",
    code: `curl -s -X POST https://shots.playbookmedia.io/api/v1/posts \\
  -H "X-API-Key: $SHOTS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: launch-post-recurring-invoices" \\
  -d '{"channelConnectionIds":["cl..."],"posts":[{"text":"Recurring invoices are here."}],"publishNow":true}'`,
  },
  {
    id: "capture",
    title: "2. Capture a live page",
    body: "This utility accepts a URL and returns a base64 PNG. Send a workspace API key in X-API-Key.",
    code: `curl -s -X POST https://shots.playbookmedia.io/api/screenshot \\
  -H "X-API-Key: $SHOTS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com","deviceType":"desktop"}' \\
  | jq -r .screenshot | base64 -d > shot.png`,
  },
  {
    id: "optimize",
    title: "3. Optimize the export",
    body: "Send the image back through Sharp to recompress it as WebP.",
    code: `curl -s -X POST https://shots.playbookmedia.io/api/export \\
  -H "X-API-Key: $SHOTS_API_KEY" \\
  -F "image=@shot.png" \\
  -F "format=webp" \\
  -F "qualityPreset=high" \\
  -o shot.webp`,
  },
  {
    id: "handle-errors",
    title: "4. Handle failures",
    body: "Every failing request returns the same JSON envelope. Branch on code.",
    code: `{
  "error": "URL is required",
  "code": "invalid_request",
  "message": "URL is required",
  "hint": "Send a JSON body with a \\"url\\" string.",
  "status": 400,
  "documentation": "https://shots.playbookmedia.io/docs#errors"
}`,
  },
];

export default function DevelopersPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <Navigation />

      <main className="mx-auto max-w-3xl flex-1 px-6 pb-16 pt-28 sm:pb-24">
        <h1
          className="mb-4 text-3xl font-semibold tracking-[-0.03em] text-foreground sm:text-4xl"
          style={{ fontFamily: INTER }}
        >
          Shots Developer Portal
        </h1>
        <p className="mb-12 text-lg leading-relaxed text-muted-foreground">
          Shots is an open-source screenshot editor and workspace
          platform with editor utility endpoints and a tenant REST API, both
          authenticated by a signed-in session or a workspace API key. Scalar provides an interactive reference, the contract is
          published as OpenAPI 3.1, and the application is open source under Apache 2.0.
        </p>

        <div className="space-y-12">
          <section id="resources">
            <h2
              className="mb-4 text-xl font-semibold tracking-[-0.02em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Start here
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {RESOURCES.map((resource) => (
                <Link
                  key={resource.href}
                  href={resource.href}
                  className={cardSurface}
                >
                  <p className="mb-1 font-medium text-foreground">
                    {resource.label}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {resource.detail}
                  </p>
                </Link>
              ))}
            </div>
          </section>

          <section id="api-keys">
            <h2
              className="mb-3 text-xl font-semibold tracking-[-0.02em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              API keys
            </h2>
            <p className="leading-relaxed text-muted-foreground">
              Create a workspace API key in Settings → Developer API
              (<code>/settings/developers</code>). Utility endpoints such as{" "}
              <code>/api/screenshot</code> accept a key with the artifact:read scope in{" "}
              <code>X-API-Key</code> or a signed-in session, and per-IP limits
              apply on top. Workspace-scoped <code>/api/v1</code> operations
              require a key with the declared scope or an authorized signed-in
              session. Details
              are in{" "}
              <Link href="/docs/authentication" className={linkClassName}>
                authentication and rate limits
              </Link>
              .
            </p>
          </section>

          <section id="quickstart">
            <h2
              className="mb-4 text-xl font-semibold tracking-[-0.02em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Quickstart
            </h2>
            <div className="space-y-8">
              {QUICKSTART.map((step) => (
                <div key={step.id} id={step.id}>
                  <h3 className="mb-2 text-base font-medium text-foreground">
                    {step.title}
                  </h3>
                  <p className="mb-3 leading-relaxed text-muted-foreground">
                    {step.body}
                  </p>
                  <pre className={codeBlockClassName}>
                    <code>{step.code}</code>
                  </pre>
                </div>
              ))}
            </div>
          </section>

          <section id="sandbox">
            <h2
              className="mb-3 text-xl font-semibold tracking-[-0.02em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Sandbox
            </h2>
            <p className="mb-4 leading-relaxed text-muted-foreground">
              There is no separate sandbox host. Send utility endpoints only
              disposable public inputs. Tenant API calls can read or
              mutate workspace data and may consume plan quotas, so use a test
              workspace.
            </p>
          </section>

          <section id="agents">
            <h2
              className="mb-3 text-xl font-semibold tracking-[-0.02em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Building an agent
            </h2>
            <p className="mb-4 leading-relaxed text-muted-foreground">
              Load{" "}
              <Link href="/openapi.json" className={linkClassName}>
                /openapi.json
              </Link>{" "}
              directly as a function-calling tool definition. Every operation
              carries a unique <code>operationId</code>, a description, typed
              parameters, and a response schema. Any page on this site also
              serves Markdown when asked:
            </p>
            <pre className={codeBlockClassName}>
              <code>{`curl -H "Accept: text/markdown" https://shots.playbookmedia.io/docs`}</code>
            </pre>
          </section>

          <section id="cli">
            <h2
              className="mb-3 text-xl font-semibold tracking-[-0.02em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              CLI and MCP server
            </h2>
            <p className="leading-relaxed text-muted-foreground">
              The{" "}
              <a href="/docs/agents" className={linkClassName}>
                Shots MCP server
              </a>{" "}
              lets Claude, Codex, OpenCode, and other agents write and publish
              posts. No official CLI tool is published yet; the curl examples
              above are the supported command-line path. If you want one,{" "}
              <a href="mailto:team@playbookmedia.io" className={linkClassName}>
                email us
              </a>
              .
            </p>
          </section>

          <section id="support">
            <h2
              className="mb-3 text-xl font-semibold tracking-[-0.02em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Support
            </h2>
            <p className="leading-relaxed text-muted-foreground">
              Email bugs and feature requests to{" "}
              <a href="mailto:team@playbookmedia.io" className={linkClassName}>
                team@playbookmedia.io
              </a>
              , or reach the maintainers through the{" "}
              <Link href="/contact" className={linkClassName}>
                contact page
              </Link>
              .
            </p>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
