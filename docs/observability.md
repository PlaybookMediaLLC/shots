# Observability

The Go backend and the Next.js web send OpenTelemetry traces and metrics to
[Axiom](https://axiom.co) over OTLP/HTTP. No collector runs between them.
Sentry still receives Go errors. This page covers the design, the
configuration, the Axiom setup, the monitors, the cost, and a runbook.

| Runtime                                     | Code                                           | `service.name`            |
| ------------------------------------------- | ---------------------------------------------- | ------------------------- |
| Go product API (`cmd/product-api`)          | `server/internal/telemetry`                    | `publishing-backend`      |
| Go Temporal worker (`cmd/product-worker`)   | `server/internal/telemetry`                    | `publishing-orchestrator` |
| Next.js web, Node.js runtime                | `clients/apps/web/lib/telemetry.ts`            | `shots-web`               |

The collab server and Edge code are not instrumented.

## What is measured

Traces (sampled, see [Sampling](#sampling)):

- Web: the spans Next.js makes for each request, render and `fetch`. Every
  call to the Go backend through `lib/backend/sdk.ts` carries `traceparent`,
  so the backend span joins the web request's trace (beside Next's `fetch`
  span, not under it).
- Go API: one server span per request, named `METHOD /route/{id}` from the
  `http.ServeMux` pattern (MCP calls: `POST /mcp`). Health checks (`/healthz`,
  `/readyz`) are skipped. A handler panic marks the span failed.
- Postgres: one span per query with the parameterized statement (`otelsql`).
- Redis: one span per command, without arguments (`redisotel`).
- Outbound HTTP: one client span per call on `http.DefaultTransport`. Clients
  that call customer endpoints (webhooks, audit drains, the SSRF guard) clone
  their own transport and stay untraced.
- Temporal: the API's workflow starts and signals, and each workflow and
  activity run in the worker. A workflow continues the trace of the request
  that started it. Activity errors are recorded on the span.

Metrics (never sampled, exported every 60 seconds):

| Metric                                                             | Source                                   |
| ------------------------------------------------------------------ | ---------------------------------------- |
| `http.server.request.duration` (method, route, status)             | Go `otelhttp`; web, from each routed or failed request |
| `http.client.request.duration` (method, host, status)              | Go outbound calls                        |
| `db.client.operation.duration`, `db.sql.connection.*`              | Postgres queries and pool, per pool name |
| `db.client.connections.*`                                          | Redis pool, per pool name                |
| `temporal_*` (task latency, schedule-to-start, failures, slots)    | Temporal SDK                             |
| `go.memory.*`, `go.goroutine.count`, `go.schedule.duration`        | Go runtime                               |
| `nodejs.eventloop.delay.p99/max`, `process.memory.usage`, `process.cpu.time` | Web runtime                    |

App Platform reports container CPU, memory and restarts. Use its alerts for
those; this setup does not duplicate them.

## Sampling

| Signal                                    | Policy                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| New traces                                | `OTEL_SAMPLING_RATE` (default 1%), decided once per trace              |
| Child spans and downstream services       | Follow the trace's decision                                            |
| Failed spans (error status, HTTP 5xx)     | Kept from unsampled traces, at most `OTEL_PROMOTED_SPANS_PER_SECOND`   |
| Slow spans (at least `OTEL_SLOW_SPAN_THRESHOLD`) | Kept under the same limit; not `RunWorkflow` spans, which last as long as their workflow |
| Health checks                             | Not recorded                                                           |
| Background work (cron workflows)          | Same rate as new traces                                                |
| Metrics                                   | Not sampled                                                            |
| Error events                              | Sentry, which groups and deduplicates them                             |

How it works:

1. The sampler decides at the start of a trace. Spans it does not sample are
   still recorded in memory but not exported.
2. When a recorded span ends with an error, a 5xx status, or a duration over
   the threshold, the processor exports it under a token bucket (10 a second
   by default, bursts of 10 seconds' worth). It has `sampling.promoted=true`.
3. Everything else is dropped in memory.

Limits you must know:

- A promoted span arrives without its successful siblings. You see the failed
  query and the failed request, not the fast queries around them.
- In an error storm, the rate limit keeps only some failures. Use metrics for
  counts and rates. Never compute an error rate from traces.
- The Go internal port trusts the web's sampled flag. The public MCP port
  starts a new trace and only links the caller's. The web ignores a caller's
  flag and decides from a hash of the trace ID with a secret of the process,
  so a caller cannot choose a trace ID that is always sampled.
- An outbound Go call that gets a 4xx has error status, so it can be promoted.
  An inbound 4xx is not a failure.
- A Go handler that panics answers a JSON 500, logs its stack and fails its
  span. If part of the response was already sent, the server aborts the
  connection instead, and the request is not in `http.server.request.duration`.
- The web metric measures a page from `proxy.ts` to the end of its render.
  Responses that `proxy.ts` sends itself (redirects, 406) and unrouted 404s
  are not counted.
- At shutdown, telemetry not yet exported can be lost. Go waits up to 5
  seconds to flush. Next.js exits without waiting, so the web can lose up to
  one `OTEL_BSP_SCHEDULE_DELAY` of spans and one `OTEL_METRIC_EXPORT_INTERVAL`
  of metrics on each deploy.

Why no collector: tail sampling in an OpenTelemetry Collector keeps complete
error traces, but it needs a stateful service sized for all spans, routing by
trace ID across replicas, and its own monitoring. Promotion keeps the failing
spans at no infrastructure cost. Add a collector when complete error traces
justify that work.

## Configuration

Telemetry is off unless `OTEL_ENABLED=true`. An invalid setting logs
`telemetry disabled` and the process runs without telemetry. If Axiom is down,
export fails in the background, the queue drops spans when full, and requests
continue.

| Variable                                  | Default        | Meaning                                                    |
| ----------------------------------------- | -------------- | ---------------------------------------------------------- |
| `OTEL_ENABLED`                            | `false`        | `true` turns telemetry on                                  |
| `OTEL_SAMPLING_RATE`                      | `0.01`         | Share of new traces kept whole, 0 to 1                     |
| `OTEL_SLOW_SPAN_THRESHOLD`                | `2s`           | A span this long is kept; `0` keeps no slow spans          |
| `OTEL_PROMOTED_SPANS_PER_SECOND`          | `10`           | Failed and slow spans kept a second; `0` keeps none        |
| `OTEL_EXPORTER_OTLP_ENDPOINT`             | none, required | `https://us-east-1.aws.edge.axiom.co` (or your region)     |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`       | none           | `authorization=Bearer <token>,x-axiom-dataset=<traces>`    |
| `OTEL_EXPORTER_OTLP_METRICS_HEADERS`      | none           | `authorization=Bearer <token>,x-axiom-metrics-dataset=<metrics>` |
| `OTEL_RESOURCE_ATTRIBUTES`                | none           | `deployment.environment.name=production`                   |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` | `otlp`   | `none` turns one signal off                                |
| `OTEL_EXPORTER_OTLP_TIMEOUT`              | `10000`        | Milliseconds for one export attempt; retries stop at `OTEL_BSP_EXPORT_TIMEOUT` and, at shutdown, after 5 seconds |
| `OTEL_BSP_SCHEDULE_DELAY`                 | `5000`         | Milliseconds between span batches                          |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`          | `512`          | Spans in one batch                                         |
| `OTEL_BSP_MAX_QUEUE_SIZE`                 | `2048`         | Spans held before the queue drops new ones                 |
| `OTEL_BSP_EXPORT_TIMEOUT`                 | `30000`        | Milliseconds for one batch export                          |
| `OTEL_METRIC_EXPORT_INTERVAL`             | `60000`        | Milliseconds between metric exports                        |
| `OTEL_EXPORTER_OTLP_COMPRESSION`          | `gzip` in Go   | Set `gzip` for the web (the deploy script does)            |
| `OTEL_SERVICE_NAME`                       | per process    | Do not set it on the combined backend: both processes would share it |

Fixed limits: span attribute values are cut at 2,048 characters, and each
metric keeps at most 2,000 attribute sets (extra sets go to one overflow
series). `service.version` is the commit SHA: `SERVICE_VERSION` in the Go
image and `NEXT_DEPLOYMENT_ID` in the web build.

Before export, both runtimes remove the client address, the user agent, the
query string and Redis's connection string. They replace query strings, URL
credentials, `Bearer` and `Basic` values, and `token=`, `password=`,
`client_secret=` and similar pairs in all text with `REDACTED`.

### Local

Add the variables to `.local/dev.env`. The web, the API and the worker
containers read that file. To see the data without Axiom, run any OTLP/HTTP
receiver on port 4318 and set `OTEL_EXPORTER_OTLP_ENDPOINT` to it.

### Production

The settings live in Infisical beside the other app secrets. The backend
deploy (`infra/digitalocean/consolidate-live-spec.py`) copies `OTEL_ENABLED`,
`OTEL_SAMPLING_RATE`, `OTEL_EXPORTER_OTLP_ENDPOINT`, both header variables,
`OTEL_RESOURCE_ATTRIBUTES`, `OTEL_PROMOTED_SPANS_PER_SECOND`,
`OTEL_SLOW_SPAN_THRESHOLD` and `OTEL_BSP_MAX_QUEUE_SIZE` to the backend and the
web as secrets. It adds `OTEL_EXPORTER_OTLP_COMPRESSION=gzip` to the web. Run
the backend deploy after you add or change a key; a web-only deploy refreshes
existing values and removes the keys that left Infisical. Remove the keys from
Infisical and redeploy to turn telemetry off.

## Axiom setup

Axiom org `solomon-ai-hqno`, region US East 1 (AWS), 30-day retention, the same
naming as the other products' datasets:

- `shots-traces-production`, kind **Events**, for traces.
- `shots-metrics-production`, kind **Metrics**, for metrics. Axiom requires a
  separate dataset for each signal.

Infisical (`prod`, `/screenshot-studio`) holds `OTEL_ENABLED=true`,
`OTEL_SAMPLING_RATE=0.01`,
`OTEL_EXPORTER_OTLP_ENDPOINT=https://us-east-1.aws.edge.axiom.co` and
`OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production`. To turn
telemetry on:

1. In Axiom, create an API token that can only ingest into the two datasets.
2. In Infisical, add:
   - `OTEL_EXPORTER_OTLP_TRACES_HEADERS` =
     `authorization=Bearer <token>,x-axiom-dataset=shots-traces-production`
   - `OTEL_EXPORTER_OTLP_METRICS_HEADERS` =
     `authorization=Bearer <token>,x-axiom-metrics-dataset=shots-metrics-production`
3. Run the backend deploy. Each process logs `telemetry enabled` with its
   sampling rate.
4. When data arrives, create the "telemetry silent" monitors below. Before
   that they would alert at once.

## Dashboards and monitors

Alert on metrics: they count every request. Metrics are exported with delta
temporality, as in the other datasets of the org: a counter or histogram
point holds the change in its interval, so the monitors sum over a window and
read percentiles with `interpolate_delta_histogram`. (The Go runtime's
`go.schedule.duration` stays cumulative.) Every query below was checked
against Axiom's query API. Names follow the org: `[P1]` pages through
"Better Stack incident (page)", `[P2]` uses "Better Stack incident".

| Monitor                                       | Query on `shots-metrics-production`                                                                                                                                                         | Alert when                    | State |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----- |
| `[P1][production] Shots 5xx`                   | `` `http.server.request.duration` \| where `axiom.histogram` == "count" and `http.response.status_code` >= 500 \| align to 10m using sum \| group by `service.name` using sum ``           | ≥ 5 in 10 min, every 5 min    | Created |
| `[P1][production] Shots API telemetry silent`  | `` `go.goroutine.count` \| where `service.name` == "publishing-backend" \| align to 15m using count \| group using sum ``                                                                 | < 1 in 15 min, alert on no data | Created |
| `[P1][production] Shots worker telemetry silent` | Same, `service.name` == "publishing-orchestrator"                                                                                                                                          | < 1 in 15 min, alert on no data | Created |
| `[P1][production] Shots web telemetry silent`  | `` `process.memory.usage` \| where `service.name` == "shots-web" \| align to 15m using count \| group using sum ``                                                                         | < 1 in 15 min, alert on no data | Created |
| `[P2][production] Shots p95 latency`           | `` `http.server.request.duration` \| bucket by `service.name` to 10m using interpolate_delta_histogram(0.95) ``                                                                             | > 2 s, every 10 min           | Created |
| `[P2][production] Shots worker job failures`   | `` `temporal_activity_execution_failed` \| align to 30m using sum \| group by `activity_type` using sum ``                                                                                | ≥ 3 in 30 min, every 15 min   | Created |
| `[P2][production] Shots worker queue lag p95`  | `` `temporal_activity_schedule_to_start_latency` \| bucket by `task_queue` to 10m using interpolate_delta_histogram(0.95) ``                                                                | > 60 s, every 10 min          | Created |
| `[P2][production] Shots DB pool waiting`       | `` `db.sql.connection.wait` \| align to 5m using sum \| group by `service.name`, `db.client.connection.pool.name` using sum ``                                                             | > 10 in 5 min, every 5 min    | Created |
| `[P2][production] Shots dependency 5xx`        | `` `http.client.request.duration` \| where `axiom.histogram` == "count" and `http.response.status_code` >= 500 \| align to 10m using sum \| group by `server.address` using sum ``         | ≥ 10 in 10 min, every 5 min   | Created |
| `[P2][production] Shots web event loop delay`  | `` `nodejs.eventloop.delay.p99` \| align to 10m using max \| group by `service.name` using max ``                                                                                         | > 0.5 s, every 10 min         | Created |

Each query is written `` `shots-metrics-production`:<query> `` in Axiom. For
exception trends, query the traces dataset (APL): `['shots-traces-production']
| where ['status.code'] == "ERROR" | summarize count() by bin_auto(_time),
['service.name'], name`. Those counts are capped by the promotion limit.

Axiom builds an OpenTelemetry traces dashboard for `shots-traces-production`
once traces arrive. For a metrics dashboard, chart the queries above without
thresholds.

## Cost

Assumptions: a web request produces about 12 spans across the web and the
backend, about 1 KB each, so a sampled trace is about 12 KB. Metrics produce
about 1,000 active series per deployment, exported every minute, about
0.2 KB per data point.

| Traffic   | Requests a month | Sampled traces (1%) | Metrics   | Total a month |
| --------- | ---------------- | ------------------- | --------- | ------------- |
| 10 req/s  | 26 million       | 3 GB                | 9 GB      | about 12 GB   |
| 100 req/s | 260 million      | 31 GB               | 9 GB      | about 40 GB   |
| 1,000 req/s | 2.6 billion    | 310 GB              | 9 GB      | about 320 GB  |

Promoted spans add little while the error rate is low. Their ceiling is
`OTEL_PROMOTED_SPANS_PER_SECOND` per process: at 10 a second and 3 processes,
at most about 93 GB in a month of continuous failures.

Axiom's Personal plan includes 500 GB of ingest a month, and Axiom Cloud ($25
a month) includes 1 TB, then $0.12 a GB (prices from axiom.co/pricing, October
2026). All three rows fit in the included ingest. For comparison, 100%
sampling at 100 req/s is about 3.1 TB a month, about $260 a month in overage.

Check the real volume in Axiom's usage page after the first week, and
replace the assumptions above with it.

## Runbook

**No data in Axiom.**

1. Find the startup line. `telemetry enabled` means the process exports.
   `telemetry disabled: <reason>` names the bad setting.
2. Find `telemetry export failed` warnings (Go) or OpenTelemetry warnings
   and errors (web). A 401 or 403 is the token or the dataset name. A 404 is the endpoint: give the base URL, not `/v1/traces`.
   A rejected metrics export usually means the metrics dataset is not of kind
   Metrics.
3. On the combined backend, both processes read the `TENANT_OTEL_*` values
   from the deploy script.

**A failing request has no trace.** It was not sampled, and its spans were
not promoted because the rate limit was full or the span did not fail (an inbound 4xx
is not a failure). Find the trace ID in Sentry (`traceId` tag on onboarding
errors) or search `shots-traces-production` for the route and time. For a short
investigation, raise `OTEL_SAMPLING_RATE` or `OTEL_PROMOTED_SPANS_PER_SECOND`
in Infisical and redeploy. Set it back after.

**Web and backend spans are in different traces.** Only calls made through
`lib/backend/sdk.ts` carry `traceparent`. Requests to the public MCP port
start a new trace on purpose and link the caller's.

**Spans are dropped.** The batch queue was full. Raise
`OTEL_BSP_MAX_QUEUE_SIZE`, or lower the sampling rate. For counts of dropped
Go spans, set `OTEL_GO_X_OBSERVABILITY=true` (experimental). It exports
`otel.sdk.processor.span.processed` with `error.type` on drops.

**Ingest is too high.** Check the sampling rate and the promoted-span rate
first. Then look for a metric with many series, such as a route pattern that
contains IDs.

**Turn telemetry off now.** Set `OTEL_ENABLED=false` in Infisical and
redeploy. Turning it off does not change application behavior.
