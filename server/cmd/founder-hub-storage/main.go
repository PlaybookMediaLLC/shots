package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// This private listener preserves the existing REST and Storage wire contracts over the Shots database.
func handler(restOrigin, storageOrigin string) (http.Handler, error) {
	mux := http.NewServeMux()
	for prefix, origin := range map[string]string{"/rest/v1/": restOrigin, "/storage/v1/": storageOrigin} {
		target, err := url.Parse(origin)
		if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" ||
			target.User != nil || (target.Path != "" && target.Path != "/") || target.RawQuery != "" || target.Fragment != "" {
			return nil, errors.New("storage upstreams must be HTTP(S) origins without credentials")
		}
		proxy := &httputil.ReverseProxy{
			Rewrite: func(request *httputil.ProxyRequest) {
				request.SetURL(target)
				request.Out.URL.Path = "/" + strings.TrimPrefix(request.In.URL.Path, prefix)
				request.Out.URL.RawPath = ""
				if request.In.URL.RawPath != "" {
					request.Out.URL.RawPath = "/" + strings.TrimPrefix(request.In.URL.RawPath, prefix)
				}
			},
			Transport: &http.Transport{
				DialContext:       (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
				ForceAttemptHTTP2: true, MaxIdleConns: 100, IdleConnTimeout: 90 * time.Second,
				TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 10 * time.Minute,
			},
			ModifyResponse: func(response *http.Response) error {
				if location := response.Header.Get("Location"); location != "" {
					resolved, err := response.Request.URL.Parse(location)
					if err != nil || resolved.Scheme != target.Scheme || resolved.Host != target.Host {
						return errors.New("invalid private storage redirect")
					}
					resolved.Scheme, resolved.Host = "", ""
					resolved.Path = strings.TrimSuffix(prefix, "/") + resolved.Path
					if resolved.RawPath != "" {
						resolved.RawPath = strings.TrimSuffix(prefix, "/") + resolved.RawPath
					}
					response.Header.Set("Location", resolved.String())
				}
				return nil
			},
			ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
				http.Error(w, "Storage upstream unavailable", http.StatusBadGateway)
			},
		}
		mux.Handle(prefix, proxy)
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	return mux, nil
}

func main() {
	handler, err := handler(os.Getenv("FOUNDER_HUB_REST_ORIGIN"), os.Getenv("FOUNDER_HUB_STORAGE_ORIGIN"))
	if err != nil {
		log.Fatal(err)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "55530"
	}
	server := &http.Server{Addr: net.JoinHostPort("127.0.0.1", port), Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan struct{})
	go func() {
		<-ctx.Done()
		drain, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = server.Shutdown(drain)
		close(done)
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-done
}
