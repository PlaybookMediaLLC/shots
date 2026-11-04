import { Metadata } from "next";
import Link from "next/link";
import { Navigation } from "@/components/landing/Navigation";
import { Footer } from "@/components/landing/Footer";
import { OG_DEFAULTS } from "@/lib/seo/metadata";
import { INTER, codeBlockClassName, linkClassName } from "@/lib/seo/docs-shared";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table'

export const metadata: Metadata = {
  title: "Shots API Authentication",
  description:
    "Authentication for Shots editor utility endpoints and workspace-scoped /api/v1 tenant operations: signed-in sessions and workspace API keys.",
  keywords: [
    "Shots API authentication",
    "Shots API key",
    "screenshot API rate limit",
    "screenshot API key",
  ],
  openGraph: {
    ...OG_DEFAULTS,
    title: "Shots API Authentication",
    description:
      "Workspace API keys, signed-in sessions, and rate-limit semantics for editor utilities and tenant endpoints.",
    url: "/docs/authentication",
  },
  alternates: {
    canonical: "/docs/authentication",
  },
};

const LIMITS = [
  {
    endpoint: "POST /api/screenshot",
    limit: "20 requests per minute per IP",
    notes: "Returns 429 with Retry-After and X-RateLimit-* headers.",
  },
  {
    endpoint: "POST /api/export",
    limit: "Unmetered",
    notes: "Bounded by request body size and server processing time.",
  },
  {
    endpoint: "GET /api/tweet/{id}",
    limit: "Unmetered",
    notes: "Bounded by the upstream syndication API.",
  },
  {
    endpoint: "GET /api/image-proxy",
    limit: "Unmetered",
    notes: "Restricted to an allowlist of Twitter media hosts.",
  },
];

export default function AuthenticationPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <Navigation />

      <main className="mx-auto max-w-3xl flex-1 px-6 pb-16 pt-28 sm:pb-24">
        <h1
          className="mb-4 text-3xl font-semibold tracking-[-0.03em] text-foreground sm:text-4xl"
          style={{ fontFamily: INTER }}
        >
          Shots API Authentication
        </h1>
        <p className="mb-12 text-lg leading-relaxed text-muted-foreground">
          Shots has two API surfaces. Editor utility endpoints such
          as <code>/api/screenshot</code> require a signed-in session or a
          workspace API key with the artifact:read scope, and per-IP limits apply on top.
          Versioned <code>/api/v1</code> tenant endpoints require a workspace
          API key with the declared scope or a signed-in user session with the
          matching permission. Create a workspace API key in Settings →
          Developer API (<code>/settings/developers</code>).
        </p>

        <div className="space-y-10">
          <section id="utility-credentials">
            <h2
              className="mb-3 text-xl font-semibold tracking-[-0.02em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Editor utility endpoints
            </h2>
            <p className="mb-4 leading-relaxed text-muted-foreground">
              The utility endpoints listed below accept a signed-in session,
              which is how the editor calls them, or a workspace API key with
              the artifact:read scope in <code>X-API-Key</code>. A request with neither
              returns 401 with code <code>unauthorized</code>. There is no free
              plan: a workspace without an active plan gets 403 with code{" "}
              <code>workspace_feature_not_entitled</code>. A complete
              capture request looks like this:
            </p>
            <pre className={codeBlockClassName}>
              <code>{`curl -X POST https://shots.playbookmedia.io/api/screenshot \\
  -H "X-API-Key: $SHOTS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com"}'`}</code>
            </pre>
          </section>

          <section id="tenant-credentials">
            <h2
              className="mb-3 text-xl font-semibold tracking-[-0.02em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Tenant API credentials
            </h2>
            <p className="mb-4 leading-relaxed text-muted-foreground">
              Calls to <code>/api/v1</code> operate on workspace data. Machine
              callers send an organization key in <code>X-API-Key</code>.
              Browser callers may use their signed-in session. The server checks
              workspace membership, role permission, API-key scope, plan
              feature, and quota where the operation requires them.
            </p>
            <pre className={codeBlockClassName}>
              <code>{`curl https://shots.playbookmedia.io/api/v1/releases \\
  -H "X-API-Key: $SHOTS_API_KEY"`}</code>
            </pre>
          </section>

          <section id="rate-limits">
            <h2
              className="mb-3 text-xl font-semibold tracking-[-0.02em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Rate limits
            </h2>
            <div className="overflow-x-auto">
              <Table className="w-full text-left text-sm">
                <TableHeader>
                  <TableRow className="border-b border-border">
                    <TableHead className="whitespace-normal py-2 pr-4 font-medium text-foreground">
                      Endpoint
                    </TableHead>
                    <TableHead className="whitespace-normal py-2 pr-4 font-medium text-foreground">
                      Limit
                    </TableHead>
                    <TableHead className="whitespace-normal py-2 font-medium text-foreground">Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {LIMITS.map((row) => (
                    <TableRow key={row.endpoint} className="border-b border-border/60">
                      <TableCell className="whitespace-normal py-2 pr-4 font-mono text-xs text-foreground">
                        {row.endpoint}
                      </TableCell>
                      <TableCell className="whitespace-normal py-2 pr-4 text-muted-foreground">
                        {row.limit}
                      </TableCell>
                      <TableCell className="whitespace-normal py-2 text-muted-foreground">
                        {row.notes}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          <section id="handling-429">
            <h2
              className="mb-3 text-xl font-semibold tracking-[-0.02em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Handling 429
            </h2>
            <p className="mb-4 leading-relaxed text-muted-foreground">
              When the limit is exceeded the response carries{" "}
              <code>Retry-After</code> in seconds alongside{" "}
              <code>X-RateLimit-Limit</code>,{" "}
              <code>X-RateLimit-Remaining</code>, and{" "}
              <code>X-RateLimit-Reset</code>. Wait for{" "}
              <code>Retry-After</code> before retrying.
            </p>
            <pre className={codeBlockClassName}>
              <code>{`{
  "error": "Rate limit exceeded. Please try again later.",
  "code": "rate_limited",
  "message": "Rate limit exceeded. Please try again later.",
  "hint": "Wait 42 seconds, then retry. This endpoint allows 20 requests per minute per IP address.",
  "status": 429,
  "documentation": "https://shots.playbookmedia.io/docs#errors",
  "retryAfter": 42
}`}</code>
            </pre>
          </section>

          <section id="maintenance-endpoints">
            <h2
              className="mb-3 text-xl font-semibold tracking-[-0.02em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Credentialed maintenance endpoints
            </h2>
            <p className="leading-relaxed text-muted-foreground">
              A small number of cache-maintenance endpoints require a shared
              secret held by the maintainers. They are internal operations and
              are deliberately absent from the{" "}
              <Link href="/openapi.json" className={linkClassName}>
                OpenAPI specification
              </Link>
              .
            </p>
          </section>

          <section id="next">
            <h2
              className="mb-3 text-xl font-semibold tracking-[-0.02em] text-foreground"
              style={{ fontFamily: INTER }}
            >
              Next steps
            </h2>
            <p className="leading-relaxed text-muted-foreground">
              Read the full{" "}
              <Link href="/docs" className={linkClassName}>
                API documentation
              </Link>
              , browse the{" "}
              <Link href="/developers" className={linkClassName}>
                developer portal
              </Link>
              , or fetch the{" "}
              <Link href="/openapi.json" className={linkClassName}>
                OpenAPI 3.1 specification
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
