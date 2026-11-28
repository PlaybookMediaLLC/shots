import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAccept,
  qualityFor,
  prefersMarkdown,
  isUnacceptable,
} from "../lib/agents/accept";
import {
  AGENT_PAGES,
  BASE_URL,
  AGENT_RESOURCES,
  findAgentPage,
  normalizeAgentPath,
  renderAgentPageMarkdown,
  renderNotAcceptableMarkdown,
  renderNotFoundMarkdown,
} from "../lib/agents/site-content";
import { openApiSpec } from "../lib/api/openapi";
import { apiKeyScopes } from "../lib/auth/api-key-scopes";
import { apiErrorBody, apiError, methodNotAllowed, notFoundJson } from "../lib/api/errors";
import { llmsTxt, llmsFullTxt } from "../lib/agents/llms";
import { GET as getApiReference } from "../app/api-reference/route";

test("parseAccept reads media ranges and q values", () => {
  assert.deepEqual(parseAccept(null), []);
  assert.deepEqual(parseAccept("text/markdown"), [
    { type: "text", subtype: "markdown", q: 1 },
  ]);
  assert.deepEqual(parseAccept("text/markdown;q=0.4, text/html"), [
    { type: "text", subtype: "markdown", q: 0.4 },
    { type: "text", subtype: "html", q: 1 },
  ]);
  assert.deepEqual(parseAccept("*/*;q=abc"), [
    { type: "*", subtype: "*", q: 1 },
  ]);
});

test("qualityFor honours exact, subtype wildcard, and full wildcard matches", () => {
  const ranges = parseAccept("text/*;q=0.5, */*;q=0.1, text/markdown;q=0.9");
  assert.equal(qualityFor(ranges, "text/markdown"), 0.9);
  assert.equal(qualityFor(ranges, "text/html"), 0.5);
  assert.equal(qualityFor(ranges, "image/png"), 0.1);
  assert.equal(qualityFor(parseAccept("text/html"), "text/markdown"), 0);
});

test("prefersMarkdown only diverts explicit, higher-ranked markdown requests", () => {
  assert.equal(prefersMarkdown("text/markdown"), true);
  assert.equal(prefersMarkdown("text/x-markdown"), true);
  assert.equal(prefersMarkdown("text/markdown, text/html;q=0.5"), true);
  assert.equal(prefersMarkdown("text/markdown;q=0.9, text/html;q=0.8"), true);

  assert.equal(prefersMarkdown(null), false);
  assert.equal(prefersMarkdown("*/*"), false);
  assert.equal(prefersMarkdown("text/html"), false);
  assert.equal(
    prefersMarkdown(
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
    ),
    false,
  );
  assert.equal(prefersMarkdown("text/markdown;q=0.5, text/html;q=0.9"), false);
  assert.equal(prefersMarkdown("text/markdown;q=1, text/html;q=1"), false);
  assert.equal(prefersMarkdown("text/markdown;q=0"), false);
});

test("isUnacceptable is true only when every supported type is ruled out", () => {
  assert.equal(isUnacceptable("application/json"), true);
  assert.equal(isUnacceptable("text/html;q=0, text/markdown;q=0"), true);

  assert.equal(isUnacceptable(null), false);
  assert.equal(isUnacceptable("*/*"), false);
  assert.equal(isUnacceptable("text/html"), false);
  assert.equal(isUnacceptable("text/markdown"), false);
  assert.equal(isUnacceptable("application/json, */*;q=0.1"), false);
});

test("agent page registry is unique and rooted", () => {
  const paths = AGENT_PAGES.map((page) => page.path);
  assert.equal(new Set(paths).size, paths.length);
  for (const path of paths) {
    assert.ok(path === "/" || /^\/[a-z0-9/-]+$/.test(path), path);
    assert.ok(!path.endsWith("/") || path === "/", path);
  }
  for (const path of ["/", "/docs", "/docs/authentication", "/developers"]) {
    assert.ok(findAgentPage(path), `missing agent page ${path}`);
  }
});

test("normalizeAgentPath strips locale prefixes and trailing slashes", () => {
  assert.equal(normalizeAgentPath("/"), "/");
  assert.equal(normalizeAgentPath("/es"), "/");
  assert.equal(normalizeAgentPath("/es/"), "/");
  assert.equal(normalizeAgentPath("/docs/"), "/docs");
  assert.equal(normalizeAgentPath("/ja/docs/authentication"), "/docs/authentication");
  assert.equal(normalizeAgentPath("/design"), "/design");
  assert.equal(findAgentPage("/de/developers/")?.path, "/developers");
});

test("rendered markdown carries a heading, canonical URL, and resources", () => {
  const page = findAgentPage("/docs");
  assert.ok(page);
  const md = renderAgentPageMarkdown(page);
  assert.ok(md.startsWith(`# ${page.title}`));
  assert.match(md, /## Canonical URL/);
  assert.match(md, /https:\/\/shots\.playbookmedia\.io\/docs/);
  for (const resource of AGENT_RESOURCES) {
    assert.ok(md.includes(resource.url), `missing ${resource.url}`);
  }
});

test("404 and 406 markdown bodies guide an agent to a next step", () => {
  const notFound = renderNotFoundMarkdown("/nope");
  assert.ok(notFound.startsWith("# 404 Not Found"));
  assert.match(notFound, /\/nope/);
  assert.match(notFound, /## Where to look next/);
  assert.match(notFound, /openapi\.json/);

  const notAcceptable = renderNotAcceptableMarkdown("application/json");
  assert.ok(notAcceptable.startsWith("# 406 Not Acceptable"));
  assert.match(notAcceptable, /text\/markdown/);
  assert.match(notAcceptable, /application\/json/);
});

test("llms.txt files advertise the developer resources", () => {
  for (const doc of [llmsTxt, llmsFullTxt]) {
    assert.match(doc, /\/openapi\.json/);
    assert.match(doc, /\/docs/);
    assert.match(doc, /\/developers/);
  }
});

test("Scalar renders the canonical OpenAPI document", async () => {
  const response = getApiReference();
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(html, /Shots API Reference/);
  assert.match(html, /\/openapi\.json/);
  assert.match(html, /scalar/i);
});

test("openapi document is a valid 3.1 shape", () => {
  assert.equal(openApiSpec.openapi, "3.1.0");
  assert.ok(openApiSpec.info.title);
  assert.ok(openApiSpec.info.version);
  assert.ok(openApiSpec.info.description.length > 40);
  assert.ok(openApiSpec.servers.length > 0);
});

test("every operation is function-calling ready", () => {
  const seen = new Set<string>();
  const methods = ["get", "post", "put", "patch", "delete"] as const;

  for (const [path, item] of Object.entries(openApiSpec.paths)) {
    assert.ok(path.startsWith("/"), path);
    for (const method of methods) {
      const operation = (item as Record<string, unknown>)[method] as
        | {
            operationId?: string;
            summary?: string;
            description?: string;
            responses?: Record<string, unknown>;
            tags?: string[];
          }
        | undefined;
      if (!operation) continue;

      assert.ok(operation.operationId, `${method} ${path} has no operationId`);
      assert.ok(
        !seen.has(operation.operationId),
        `duplicate operationId ${operation.operationId}`,
      );
      seen.add(operation.operationId);
      assert.match(operation.operationId, /^[a-zA-Z][a-zA-Z0-9]*$/);
      assert.ok(operation.summary, `${operation.operationId} has no summary`);
      assert.ok(
        (operation.description ?? "").length > 20,
        `${operation.operationId} description is too thin for tool selection`,
      );
      assert.ok(operation.tags?.length, `${operation.operationId} has no tag`);
      assert.ok(
        Object.keys(operation.responses ?? {}).length > 0,
        `${operation.operationId} declares no responses`,
      );
    }
  }

  assert.ok(seen.size >= 4);
});

test("every schema reference resolves", () => {
  const names = new Set(Object.keys(openApiSpec.components.schemas));
  const refs = JSON.stringify(openApiSpec).match(/"#\/components\/schemas\/[A-Za-z]+"/g) ?? [];
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    const name = ref.replace(/"/g, "").split("/").pop() as string;
    assert.ok(names.has(name), `unresolved $ref to ${name}`);
  }
});

test("tenant OpenAPI operations declare the implemented X-API-Key scheme", () => {
  const spec = openApiSpec as unknown as {
    paths: Record<
      string,
      Record<
        string,
        { security?: readonly Record<string, readonly unknown[]>[] }
      >
    >;
    components: {
      securitySchemes: Record<string, Readonly<Record<string, unknown>>>;
    };
  };
  const scheme = spec.components.securitySchemes.workspaceApiKey;

  assert.deepEqual(scheme, {
    type: "apiKey",
    in: "header",
    name: "X-API-Key",
    description: "Workspace API key with the operation-required scope.",
  });

  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const operation of Object.values(operations)) {
      if (path.startsWith("/api/v1/")) {
        // Tenant operations take an API key with one scope or a member session.
        // Key introspection (/api/v1/auth/me) accepts any valid workspace API key
        // and refuses browser sessions. Shell operations and human decisions
        // take only a session.
        const [first, ...rest] = operation.security ?? [];
        if (path === "/api/v1/auth/me") {
          assert.deepEqual(operation.security, [{ workspaceApiKey: [] }], path);
        } else if ("workspaceApiKey" in (first ?? {})) {
          assert.equal(first.workspaceApiKey.length, 1, path);
          assert.ok(apiKeyScopes.includes(first.workspaceApiKey[0] as never), path);
          assert.deepEqual(rest, [{ workspaceSession: [] }], path);
        } else {
          assert.deepEqual(operation.security, [{ workspaceSession: [] }], path);
        }
      }
    }
  }
});

test("error envelope is stable and backward compatible", () => {
  const body = apiErrorBody(400, "invalid_request", "URL is required", "Send a url.");
  assert.equal(body.error, "URL is required");
  assert.equal(body.message, "URL is required");
  assert.equal(body.code, "invalid_request");
  assert.equal(body.status, 400);
  assert.equal(body.hint, "Send a url.");
  assert.equal(
    body.documentation,
    "https://shots.playbookmedia.io/api-reference#errors",
  );
});

test("apiError serialises extras and headers", async () => {
  const response = apiError(
    429,
    "rate_limited",
    "Rate limit exceeded.",
    "Wait and retry.",
    { retryAfter: 42 },
    { "Retry-After": "42" },
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "42");
  const json = await response.json();
  assert.equal(json.code, "rate_limited");
  assert.equal(json.retryAfter, 42);
  assert.equal(json.error, "Rate limit exceeded.");
});

test("methodNotAllowed advertises Allow and notFoundJson points at the spec", async () => {
  const response = methodNotAllowed(["POST"]);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST, OPTIONS");
  const json = await response.json();
  assert.equal(json.code, "method_not_allowed");

  const missing = notFoundJson("/api/nope");
  assert.equal(missing.status, 404);
  const missingJson = await missing.json();
  assert.equal(missingJson.code, "not_found");
  assert.match(missingJson.message, /\/api\/nope/);
  assert.match(missingJson.hint, /openapi\.json/);
});

test("agent-facing copy points at the canonical host and no upstream identity", () => {
  const sources = [llmsTxt, llmsFullTxt, BASE_URL, openApiSpec.servers[0].url];
  for (const source of sources) {
    assert.doesNotMatch(source, /screenshot-studio\.com/);
  }
  assert.doesNotMatch(llmsTxt, /screenshotstdio|kartik/i);
  assert.equal(BASE_URL, "https://shots.playbookmedia.io");
});

test("agent-facing copy does not claim images never reach a server", () => {
  const claims = /never leave (your|the) (browser|device|machine)|never uploaded to (any|a) server/i;
  assert.doesNotMatch(llmsTxt, claims);
  assert.doesNotMatch(llmsFullTxt, claims);
  for (const page of AGENT_PAGES) {
    assert.doesNotMatch(page.summary, claims);
  }
});

test("agent-facing product copy links no source repository and keeps workspace access", () => {
  const productCopy = [
    llmsTxt,
    llmsFullTxt,
    ...AGENT_PAGES.map((page) => page.summary),
  ].join("\n");

  assert.doesNotMatch(productCopy, /opennookorg\/screenshot-studio/i);
  assert.doesNotMatch(productCopy, /no signup|no paid tier|no premium tier/i);
  assert.match(llmsTxt, /signed-in workspace is required/i);
  assert.match(llmsFullTxt, /signed-in workspace is required/i);
  assert.doesNotMatch(productCopy, /github\.com\/[\w-]+\/screenshot-studio/i);
});

test("agent-facing API copy distinguishes utility and tenant authentication", () => {
  const apiCopy = [
    llmsTxt,
    llmsFullTxt,
    ...AGENT_PAGES.filter((page) =>
      ["/docs", "/docs/authentication", "/developers"].includes(page.path),
    ).flatMap((page) => [page.summary, ...(page.points ?? [])]),
  ].join("\n");

  assert.match(apiCopy, /utility endpoints[\s\S]*(X-API-Key|signed-in session)/i);
  assert.match(apiCopy, /\/api\/v1[\s\S]*(X-API-Key|signed-in session)/i);
  assert.doesNotMatch(apiCopy, /anonymous|no API key|no credential/i);
});

test('explicit key scopes accumulate actions without implicitly granting comment access', async () => {
  const {permissionsForApiKeyScopes}=await import('../lib/auth/api-key-scopes')
  assert.deepEqual(permissionsForApiKeyScopes(['draft:write','draft:comment']),{draft:['write','comment']})
  assert.deepEqual(permissionsForApiKeyScopes(['draft:write']),{draft:['write']})
})
