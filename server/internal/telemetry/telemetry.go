// Package telemetry exports OpenTelemetry traces and metrics over OTLP/HTTP,
// to Axiom in production (docs/observability.md). It keeps
// OTEL_SAMPLING_RATE of new traces whole and, from the other traces, the
// spans that fail or run slow, under a rate limit. Metrics are not sampled.
// A bad setting or an unreachable endpoint is logged; it never stops the
// process.
package telemetry

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/config"
	"github.com/XSAM/otelsql"
	"github.com/felixge/httpsnoop"
	"github.com/redis/go-redis/extra/redisotel/v9"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/instrumentation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.43.0"
	"go.opentelemetry.io/otel/trace"
	"golang.org/x/time/rate"
)

// UntracedTransport is net/http's default transport as it was before Start
// wrapped http.DefaultTransport. Clients that call customer endpoints use
// or clone it, so customers receive no trace headers and their hosts stay
// out of the dependency metrics.
var UntracedTransport = http.DefaultTransport.(*http.Transport)

// Start installs the global tracer and meter providers for service when
// OTEL_ENABLED=true and returns the function that flushes and stops them.
func Start(ctx context.Context, service string) (shutdown func()) {
	cfg, err := config.LoadTelemetry()
	if err != nil {
		slog.Error("telemetry disabled", "error", err)
		return func() {}
	}
	if !cfg.Enabled {
		return func() {}
	}
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) { slog.Warn("telemetry export failed", "error", err) }))
	otel.SetTextMapPropagator(propagation.TraceContext{})
	attributes := []attribute.KeyValue{semconv.ServiceName(service)}
	if version := os.Getenv("SERVICE_VERSION"); version != "" {
		attributes = append(attributes, semconv.ServiceVersion(version))
	}
	// OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES (deployment.environment.name)
	// override these.
	res, err := resource.New(ctx, resource.WithAttributes(attributes...), resource.WithHost(), resource.WithFromEnv())
	if err != nil {
		slog.Warn("telemetry resource incomplete", "error", err)
	}

	var stops []func(context.Context) error
	if cfg.Traces {
		if exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithCompression(otlptracehttp.GzipCompression)); err != nil {
			slog.Error("tracing disabled", "error", err)
		} else {
			provider := tracerProvider(cfg, res, exporter)
			otel.SetTracerProvider(provider)
			stops = append(stops, provider.Shutdown)
		}
	}
	if cfg.Metrics {
		if provider, err := meterProvider(ctx, res); err != nil {
			slog.Error("metrics disabled", "error", err)
		} else {
			otel.SetMeterProvider(provider)
			stops = append(stops, provider.Shutdown)
			if err := runtime.Start(); err != nil {
				slog.Warn("runtime metrics unavailable", "error", err)
			}
		}
	}
	if len(stops) == 0 {
		return func() {}
	}
	// Every client on the default transport traces and measures its calls.
	// Clients for customer endpoints clone their own transport and stay out.
	http.DefaultTransport = otelhttp.NewTransport(http.DefaultTransport)
	slog.Info("telemetry enabled", "service", service, "samplingRate", cfg.SamplingRate, "traces", cfg.Traces, "metrics", cfg.Metrics)
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		// Concurrently: a trace export that retries must not use up the
		// metrics' flush time.
		var wait sync.WaitGroup
		for _, stop := range stops {
			wait.Go(func() {
				if err := stop(ctx); err != nil {
					slog.Warn("telemetry flush failed", "error", err)
				}
			})
		}
		wait.Wait()
	}
}

func tracerProvider(cfg config.Telemetry, res *resource.Resource, exporter sdktrace.SpanExporter) *sdktrace.TracerProvider {
	// The batch processor exports in the background from a bounded queue
	// (OTEL_BSP_MAX_QUEUE_SIZE) and drops spans when it is full.
	var processor sdktrace.SpanProcessor = sdktrace.NewBatchSpanProcessor(redacting{exporter})
	sampler := sdktrace.ParentBased(sdktrace.TraceIDRatioBased(cfg.SamplingRate))
	if cfg.PromotedSpansPerSecond > 0 {
		// Spans the sampler drops are still recorded, so the promoter sees them.
		sampler = sdktrace.AlwaysRecord(sampler)
		processor = promoter{SpanProcessor: processor, slow: cfg.SlowSpan,
			limit: rate.NewLimiter(rate.Limit(cfg.PromotedSpansPerSecond), int(max(1, 10*cfg.PromotedSpansPerSecond)))}
	}
	limits := sdktrace.NewSpanLimits()
	if limits.AttributeValueLengthLimit < 0 {
		limits.AttributeValueLengthLimit = 2048
	}
	return sdktrace.NewTracerProvider(sdktrace.WithResource(res), sdktrace.WithSampler(sampler),
		sdktrace.WithSpanProcessor(processor), sdktrace.WithRawSpanLimits(limits))
}

func meterProvider(ctx context.Context, res *resource.Resource) (*sdkmetric.MeterProvider, error) {
	// Delta, as the other Axiom datasets: their monitors sum counters over a
	// window and read percentiles with interpolate_delta_histogram.
	exporter, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithCompression(otlpmetrichttp.GzipCompression),
		otlpmetrichttp.WithTemporalitySelector(sdkmetric.DeltaTemporalitySelector))
	if err != nil {
		return nil, err
	}
	// Request durations keep method, route and status. The server's host, port
	// and protocol add series that no alert needs; clients keep the host to
	// name the failing dependency. Body sizes are not exported.
	noise := []attribute.Key{"server.address", "server.port", "url.scheme", "network.protocol.name", "network.protocol.version"}
	return sdkmetric.NewMeterProvider(sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter, sdkmetric.WithProducer(runtime.NewProducer()))),
		sdkmetric.WithView(
			sdkmetric.NewView(sdkmetric.Instrument{Name: "http.server.request.duration"},
				sdkmetric.Stream{AttributeFilter: attribute.NewDenyKeysFilter(noise...)}),
			sdkmetric.NewView(sdkmetric.Instrument{Name: "http.client.request.duration"},
				sdkmetric.Stream{AttributeFilter: attribute.NewDenyKeysFilter(noise[1:]...)}),
			sdkmetric.NewView(sdkmetric.Instrument{Name: "http.*.body.size"}, sdkmetric.Stream{Aggregation: sdkmetric.AggregationDrop{}}),
			// Temporal records seconds; the default buckets start at 5.
			sdkmetric.NewView(sdkmetric.Instrument{Kind: sdkmetric.InstrumentKindHistogram, Scope: instrumentation.Scope{Name: "temporal-sdk-go"}},
				sdkmetric.Stream{Aggregation: sdkmetric.AggregationExplicitBucketHistogram{
					Boundaries: []float64{0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800}}}),
		),
		sdkmetric.WithCardinalityLimit(2000)), nil
}

// promoter passes sampled spans on and, from unsampled traces, the spans
// that failed or ran for at least slow, at most limit a second. A kept span
// arrives without its successful siblings.
type promoter struct {
	sdktrace.SpanProcessor
	slow  time.Duration
	limit *rate.Limiter
}

func (p promoter) OnEnd(span sdktrace.ReadOnlySpan) {
	if !span.SpanContext().IsSampled() {
		failed := span.Status().Code == codes.Error
		// A RunWorkflow span lasts as long as its workflow, days for a
		// scheduled post, so only a failure keeps it.
		slow := p.slow > 0 && span.EndTime().Sub(span.StartTime()) >= p.slow && !strings.HasPrefix(span.Name(), "RunWorkflow:")
		if !(failed || slow) || !p.limit.Allow() {
			return
		}
		span = promoted{span}
	}
	p.SpanProcessor.OnEnd(span)
}

// promoted reports a kept span as sampled, since the batch processor drops
// the others, and marks it so queries can tell it from the sample.
type promoted struct{ sdktrace.ReadOnlySpan }

func (s promoted) SpanContext() trace.SpanContext {
	sc := s.ReadOnlySpan.SpanContext()
	return sc.WithTraceFlags(sc.TraceFlags().WithSampled(true))
}

func (s promoted) Attributes() []attribute.KeyValue {
	return append(s.ReadOnlySpan.Attributes(), attribute.Bool("sampling.promoted", true))
}

// redacting removes client identifiers, query strings and credentials from
// spans before they leave the process.
type redacting struct{ sdktrace.SpanExporter }

func (e redacting) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	safe := make([]sdktrace.ReadOnlySpan, len(spans))
	for i, span := range spans {
		safe[i] = redacted{span}
	}
	return e.SpanExporter.ExportSpans(ctx, safe)
}

type redacted struct{ sdktrace.ReadOnlySpan }

func (s redacted) Attributes() []attribute.KeyValue { return redact(s.ReadOnlySpan.Attributes()) }

func (s redacted) Events() []sdktrace.Event {
	events := s.ReadOnlySpan.Events()
	safe := make([]sdktrace.Event, len(events))
	for i, event := range events {
		event.Attributes = redact(event.Attributes)
		safe[i] = event
	}
	return safe
}

func (s redacted) Status() sdktrace.Status {
	status := s.ReadOnlySpan.Status()
	status.Description = Scrub(status.Description)
	return status
}

// dropped are personal data (client address, user agent), the query string,
// which carries OAuth codes and tokens, and Redis's connection string, which
// can carry its password.
var dropped = map[attribute.Key]bool{"client.address": true, "network.peer.address": true, "network.peer.port": true,
	"user_agent.original": true, "url.query": true, "db.connection_string": true}

func redact(attributes []attribute.KeyValue) []attribute.KeyValue {
	safe := make([]attribute.KeyValue, 0, len(attributes))
	for _, kv := range attributes {
		if dropped[kv.Key] {
			continue
		}
		if kv.Value.Type() == attribute.STRING {
			kv.Value = attribute.StringValue(Scrub(kv.Value.AsString()))
		}
		safe = append(safe, kv)
	}
	return safe
}

// secrets match credentials inside free text such as error messages: URL
// query strings and user info, authorization headers, and key=value pairs.
var secrets = []struct {
	pattern     *regexp.Regexp
	replacement string
}{
	{regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://[^\s?#"'<>]*)\?[^\s#"'<>]*`), "${1}?REDACTED"},
	{regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@"'<>]+@`), "${1}REDACTED@"},
	{regexp.MustCompile(`(?i)\b(bearer|basic)\s+[a-z0-9._~+/=-]+`), "${1} REDACTED"},
	{regexp.MustCompile(`(?i)\b([a-z0-9_]*(?:token|secret|password|api_?key|signature))=[^&\s"']+`), "${1}=REDACTED"},
	{regexp.MustCompile(`(?i)"([a-z0-9_]*(?:token|secret|password|api_?key))"\s*:\s*"[^"]*"`), `"${1}":"REDACTED"`},
}

// Scrub removes credentials from free text: query strings, URL user info,
// authorization header values and credential key=value pairs.
func Scrub(text string) string {
	for _, secret := range secrets {
		text = secret.pattern.ReplaceAllString(text, secret.replacement)
	}
	return text
}

// Handler traces and measures every request except health checks. A public
// handler starts each trace itself and only links the caller's, so an
// internet client cannot put its requests into the sample.
func Handler(next http.Handler, public bool) http.Handler {
	// otelhttp names each span "METHOD /route/{id}" from the ServeMux pattern.
	options := []otelhttp.Option{
		otelhttp.WithFilter(func(r *http.Request) bool { return r.URL.Path != "/healthz" && r.URL.Path != "/readyz" }),
	}
	if public {
		options = append(options, otelhttp.WithPublicEndpointFn(func(*http.Request) bool { return true }))
	}
	return otelhttp.NewHandler(recordPanics(next), "http.server", options...)
}

// recordPanics turns a handler panic into a logged JSON 500, so the request
// counts in http.server.request.duration and its span fails. When part of
// the response is already out, it aborts the connection, as net/http does;
// that request fails its span but is not in the metric.
func recordPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var sent httpsnoop.Metrics // Code stays 0 until the handler writes a header.
		defer func() {
			value := recover()
			if value == nil {
				return
			}
			if value == http.ErrAbortHandler {
				panic(value)
			}
			span := trace.SpanFromContext(r.Context())
			span.RecordError(fmt.Errorf("panic: %v", value))
			slog.Error("handler panicked", "method", r.Method, "path", r.URL.Path, "panic", fmt.Sprint(value), "stack", string(debug.Stack()))
			if sent.Code != 0 || sent.Written > 0 {
				// otelhttp sets no status for an aborted response.
				span.SetStatus(codes.Error, fmt.Sprint("panic: ", value))
				panic(http.ErrAbortHandler)
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"internal server error"}` + "\n"))
		}()
		sent.CaptureMetrics(w, func(w http.ResponseWriter) { next.ServeHTTP(w, r) })
	})
}

// OpenDB opens a database/sql pool whose queries become spans and whose
// connections are measured under the pool name.
func OpenDB(pool string, connector driver.Connector) *sql.DB {
	db := otelsql.OpenDB(connector, otelsql.WithAttributes(semconv.DBSystemNamePostgreSQL),
		otelsql.WithSpanOptions(otelsql.SpanOptions{DisableErrSkip: true, OmitConnResetSession: true, OmitConnPrepare: true, OmitRows: true}))
	if _, err := otelsql.RegisterDBStatsMetrics(db, otelsql.WithAttributes(semconv.DBSystemNamePostgreSQL,
		semconv.DBClientConnectionPoolName(uniqueName(pool)))); err != nil {
		slog.Warn("database pool metrics unavailable", "error", err)
	}
	return db
}

// InstrumentRedis traces a client's commands, without their arguments, and
// measures its connection pool under the pool name. Like redisotel's default,
// it skips AUTH; it also skips the CLIENT commands of the connection
// handshake, which older Redis versions reject and go-redis ignores, so a new
// connection does not report a failure.
func InstrumentRedis(pool string, client redis.UniversalClient) {
	handshake := func(cmd redis.Cmder) bool { return redisotel.DefaultCommandFilter(cmd) || cmd.Name() == "client" }
	if err := errors.Join(
		redisotel.InstrumentTracing(client, redisotel.WithDBStatement(false), redisotel.WithCallerEnabled(false),
			redisotel.WithCommandFilter(handshake),
			redisotel.WithCommandsFilter(func(cmds []redis.Cmder) bool { return slices.ContainsFunc(cmds, handshake) })),
		redisotel.InstrumentMetrics(client, redisotel.WithPoolName(uniqueName(pool))),
	); err != nil {
		slog.Warn("Redis telemetry unavailable", "error", err)
	}
}

var (
	poolsMu sync.Mutex
	pools   = map[string]int{}
)

// uniqueName numbers the second and later pools of one name (social-2), so
// two pools never report the same metric series. Processes open their pools
// in a fixed order, so the names stay stable across restarts.
func uniqueName(name string) string {
	poolsMu.Lock()
	defer poolsMu.Unlock()
	pools[name]++
	if n := pools[name]; n > 1 {
		return fmt.Sprintf("%s-%d", name, n)
	}
	return name
}
