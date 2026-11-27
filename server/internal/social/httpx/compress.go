package httpx

import (
	"bufio"
	"compress/flate"
	"compress/gzip"
	"errors"
	"io"
	"net"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/andybalholm/brotli"
)

var (
	brotliPool = sync.Pool{New: func() any { return brotli.NewWriterLevel(io.Discard, 4) }}
	gzipPool   = sync.Pool{New: func() any { return gzip.NewWriter(io.Discard) }}
	flatePool  = sync.Pool{New: func() any {
		fw, _ := flate.NewWriter(io.Discard, flate.DefaultCompression)
		return fw
	}}
)

// Compress is the compression@1.8.1 middleware the original app installs with
// app.use(compression()): brotli (quality 4), gzip or deflate chosen by
// Accept-Encoding with br then gzip preferred, only for compressible
// Content-Types, 1kb threshold, no Cache-Control: no-transform, not HEAD, and
// Vary: Accept-Encoding whenever the type is compressible.
func Compress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cw := &compressWriter{ResponseWriter: w, r: r}
		next.ServeHTTP(cw, r)
		// Finalize only on normal return so a panic/http.ErrAbortHandler never
		// emits a valid EOF trailer over a truncated response.
		cw.close()
	})
}

const compressThreshold = 1024

var (
	noTransform      = regexp.MustCompile(`(?:^|,)\s*?no-transform\s*?(?:,|$)`)
	compressibleType = regexp.MustCompile(`(?i)^text/|\+(?:json|text|xml)$`)
	extractType      = regexp.MustCompile(`^\s*([^;\s]*)(?:;|\s|$)`)
)

// compressible is the compressible package over mime-db.
func compressible(contentType string) bool {
	match := extractType.FindStringSubmatch(contentType)
	if match == nil {
		return false
	}
	mime := strings.ToLower(match[1])
	if flag, ok := mimeCompressible[mime]; ok {
		return flag
	}
	return compressibleType.MatchString(mime)
}

type compressWriter struct {
	http.ResponseWriter
	r       *http.Request
	decided bool
	method  string
	enc     io.WriteCloser
	flusher interface{ Flush() error }
}

func (cw *compressWriter) WriteHeader(status int) {
	if !cw.decided {
		cw.decided = true
		cw.decide(status)
	}
	cw.ResponseWriter.WriteHeader(status)
}

func (cw *compressWriter) decide(status int) {
	h := cw.Header()
	if !compressible(h.Get("Content-Type")) {
		return
	}
	if cc := h.Get("Cache-Control"); cc != "" && noTransform.MatchString(cc) {
		return
	}
	vary(h, "Accept-Encoding")
	if n, err := strconv.Atoi(h.Get("Content-Length")); err == nil && n < compressThreshold {
		return
	}
	if enc := h.Get("Content-Encoding"); enc != "" && enc != "identity" {
		return
	}
	if cw.r.Method == http.MethodHead || status == http.StatusNoContent || status == http.StatusNotModified || status == http.StatusPartialContent || h.Get("Content-Range") != "" {
		return
	}
	method := negotiateEncoding(cw.r.Header.Values("Accept-Encoding"))
	if method == "" || method == "identity" {
		return
	}
	switch method {
	case "br":
		bw := brotliPool.Get().(*brotli.Writer)
		bw.Reset(cw.ResponseWriter)
		cw.enc, cw.flusher = bw, bw
	case "gzip":
		gw := gzipPool.Get().(*gzip.Writer)
		gw.Reset(cw.ResponseWriter)
		cw.enc, cw.flusher = gw, gw
	default:
		fw := flatePool.Get().(*flate.Writer)
		fw.Reset(cw.ResponseWriter)
		cw.enc, cw.flusher = fw, fw
	}
	cw.method = method
	h.Set("Content-Encoding", method)
	h.Del("Content-Length")
}

func (cw *compressWriter) Write(p []byte) (int, error) {
	if !cw.decided {
		cw.WriteHeader(http.StatusOK)
	}
	if cw.enc != nil {
		return cw.enc.Write(p)
	}
	return cw.ResponseWriter.Write(p)
}

// Flush is compression's res.flush(): it flushes the encoder, so streamed
// responses (NDJSON, SSE) reach the client as they are written.
func (cw *compressWriter) Flush() {
	if cw.flusher != nil {
		_ = cw.flusher.Flush()
	}
	if f, ok := cw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (cw *compressWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := cw.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, errors.New("hijack not supported")
}

func (cw *compressWriter) Unwrap() http.ResponseWriter { return cw.ResponseWriter }

func (cw *compressWriter) close() {
	if cw.enc == nil {
		return
	}
	_ = cw.enc.Close()
	switch cw.method {
	case "br":
		bw := cw.enc.(*brotli.Writer)
		bw.Reset(io.Discard)
		brotliPool.Put(bw)
	case "gzip":
		gw := cw.enc.(*gzip.Writer)
		gw.Reset(io.Discard)
		gzipPool.Put(gw)
	default:
		fw := cw.enc.(*flate.Writer)
		fw.Reset(io.Discard)
		flatePool.Put(fw)
	}
	cw.enc, cw.flusher = nil, nil
}

func vary(h http.Header, field string) {
	for _, existing := range h.Values("Vary") {
		for _, f := range strings.Split(existing, ",") {
			f = strings.TrimSpace(f)
			if f == "*" || strings.EqualFold(f, field) {
				return
			}
		}
	}
	h.Add("Vary", field)
}

type encodingSpec struct {
	encoding string
	q        float64
	i, o, s  int
}

// negotiateEncoding is negotiator@0.6.4's encoding(['br','gzip','deflate',
// 'identity'], ['br','gzip']). No Accept-Encoding header means identity
// (compression's enforceEncoding default).
func negotiateEncoding(header []string) string {
	if len(header) == 0 {
		return "identity"
	}
	accepts := parseAcceptEncoding(strings.Join(header, ","))
	supported := []string{"br", "gzip", "deflate", "identity"}
	preferred := []string{"br", "gzip"}
	var priorities []encodingSpec
	for index, enc := range supported {
		p := encodingSpec{encoding: enc, o: -1}
		for _, spec := range accepts {
			if s, ok := specify(enc, spec, index); ok && (p.s-s.s < 0 || (p.s == s.s && (p.q-s.q < 0 || (p.q == s.q && p.o-s.o < 0)))) {
				p = s
			}
		}
		if p.q > 0 {
			priorities = append(priorities, p)
		}
	}
	sort.SliceStable(priorities, func(x, y int) bool {
		a, b := priorities[x], priorities[y]
		if a.q != b.q {
			return a.q > b.q
		}
		ai, bi := slices.Index(preferred, a.encoding), slices.Index(preferred, b.encoding)
		switch {
		case ai == -1 && bi == -1:
			if a.s != b.s {
				return a.s > b.s
			}
			if a.o != b.o {
				return a.o < b.o
			}
			return a.i < b.i
		case ai != -1 && bi != -1:
			return ai < bi
		default:
			return ai != -1
		}
	})
	if len(priorities) == 0 {
		return ""
	}
	return priorities[0].encoding
}

func parseAcceptEncoding(accept string) []encodingSpec {
	var accepts []encodingSpec
	hasIdentity := false
	minQuality := 1.0
	parts := strings.Split(accept, ",")
	for i, part := range parts {
		spec, ok := parseEncoding(strings.TrimSpace(part), i)
		if !ok {
			continue
		}
		accepts = append(accepts, spec)
		if _, ok := specify("identity", spec, 0); ok {
			hasIdentity = true
		}
		q := spec.q
		if q == 0 {
			q = 1 // `encoding.q || 1`
		}
		minQuality = min(minQuality, q)
	}
	if !hasIdentity {
		accepts = append(accepts, encodingSpec{encoding: "identity", q: minQuality, i: len(parts)})
	}
	return accepts
}

func parseEncoding(s string, i int) (encodingSpec, bool) {
	name, params, _ := strings.Cut(s, ";")
	name = strings.TrimSpace(name)
	if name == "" || strings.ContainsAny(name, " \t") {
		return encodingSpec{}, false
	}
	q := 1.0
	for _, p := range strings.Split(params, ";") {
		key, value, _ := strings.Cut(strings.TrimSpace(p), "=")
		if key == "q" {
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil {
				parsed = 0 // parseFloat → NaN, which never passes isQuality
			}
			q = parsed
			break
		}
	}
	return encodingSpec{encoding: name, q: q, i: i}, true
}

func specify(encoding string, spec encodingSpec, index int) (encodingSpec, bool) {
	s := 0
	if strings.EqualFold(spec.encoding, encoding) {
		s |= 1
	} else if spec.encoding != "*" {
		return encodingSpec{}, false
	}
	return encodingSpec{encoding: encoding, i: index, o: spec.i, q: spec.q, s: s}, true
}
