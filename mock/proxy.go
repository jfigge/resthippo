package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// proxy.go — a small forward proxy used to exercise wurl's proxy settings and
// request-retry policy (feature 44). It runs alongside the main mock API on a
// separate port and speaks ordinary HTTP forward-proxy semantics: clients send
// absolute-URI requests (plain HTTP) or CONNECT (HTTPS tunnel) and the proxy
// relays them to the real upstream.
//
// On top of plain forwarding it understands one control header, X-PROXY-ERROR,
// which makes the proxy fail a configurable number of times before letting a
// request through — just enough to drive retry/backoff testing:
//
//	X-PROXY-ERROR: 3   →  the first two attempts for that URL return 503,
//	                      the third is forwarded upstream and succeeds.
//
// The countdown is keyed by request URL and cached for 5 minutes (see
// proxyErrorTTL); each repeat of the same URL decrements the remaining count by
// one, and reaching zero forwards the request and evicts the cache entry.

const (
	// proxyAddr is the forward-proxy listen address (sibling of the :8888 API).
	proxyAddr = ":9999"
	// proxyErrorHeader asks the proxy to simulate N-1 transient failures before
	// the request for a given URL is allowed through. Its value is an integer.
	// Header lookups are case-insensitive, so the client may send it as
	// "X-PROXY-ERROR"; Go canonicalises it to this spelling.
	proxyErrorHeader = "X-Proxy-Error"
	// proxyErrorTTL bounds how long a URL's failure countdown survives between
	// attempts before it resets to the header value again.
	proxyErrorTTL = 5 * time.Minute
	// proxyRelayHeader is stamped onto every response the proxy controls so a
	// client can tell the request passed through it: forwarded responses, the
	// simulated X-PROXY-ERROR failures, and the CONNECT acknowledgement. The
	// tunnelled HTTPS response itself is end-to-end TLS and can't be marked.
	proxyRelayHeader = "X-Proxy-Relayed"
	// proxyRelayValue identifies this proxy in the relay header.
	proxyRelayValue = "wurl-mock"
)

// hopHeaders are the HTTP hop-by-hop headers a proxy must not forward upstream
// (RFC 7230 §6.1).
var hopHeaders = []string{
	"Connection",
	"Proxy-Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"Te",
	"Trailer",
	"Transfer-Encoding",
	"Upgrade",
}

// proxyTransport relays forwarded requests upstream. Proxy is nil so the mock
// proxy never chains to a real, environment-configured proxy.
var proxyTransport = &http.Transport{Proxy: nil}

// errorCache tracks the per-URL X-PROXY-ERROR countdown.
var errorCache = newProxyCache()

// proxyEntry is one key's remaining-failure countdown and its expiry.
type proxyEntry struct {
	remaining int
	expires   time.Time
}

// proxyCache is a small TTL map guarding the X-PROXY-ERROR countdowns. Handlers
// run concurrently, so every access is mutex-guarded.
type proxyCache struct {
	mu      sync.Mutex
	entries map[string]proxyEntry
}

func newProxyCache() *proxyCache {
	return &proxyCache{entries: make(map[string]proxyEntry)}
}

// countdown applies a single X-PROXY-ERROR tick for key. The first sighting of a
// key (or the first after its TTL lapses) seeds the counter at headerVal-1;
// every later sighting decrements the cached value by one. It returns the new
// remaining count and whether the caller should now forward the request — true
// once the count reaches zero, at which point the entry is evicted so a later
// request starts a fresh countdown.
func (c *proxyCache) countdown(key string, headerVal int) (remaining int, forward bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if e, ok := c.entries[key]; ok && now.Before(e.expires) {
		remaining = e.remaining - 1
	} else {
		remaining = headerVal - 1
	}
	if remaining <= 0 {
		delete(c.entries, key)
		return 0, true
	}
	c.entries[key] = proxyEntry{remaining: remaining, expires: now.Add(proxyErrorTTL)}
	return remaining, false
}

// startProxyServer runs the forward proxy on proxyAddr. It blocks, so main()
// launches it in its own goroutine.
func startProxyServer() {
	srv := &http.Server{Addr: proxyAddr, Handler: http.HandlerFunc(proxyHandler)}
	fmt.Fprintln(os.Stderr, "mock proxy listening on", proxyAddr)
	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintln(os.Stderr, "proxy:", err)
	}
}

// proxyHandler is the forward-proxy entry point: CONNECT tunnels for HTTPS,
// absolute-URI requests for plain HTTP, and a friendly 400 for anything that
// hits the proxy port without going through it.
func proxyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		proxyConnect(w, r)
		return
	}
	if !r.URL.IsAbs() {
		http.Error(w,
			"this is wurl's mock forward proxy — point a client's proxy setting at it and send absolute-URI or CONNECT requests",
			http.StatusBadRequest)
		return
	}
	if !proxyErrorGate(w, r, r.URL.String()) {
		return
	}
	proxyForward(w, r)
}

// proxyErrorGate applies the X-PROXY-ERROR countdown for key. It returns true
// when the request should proceed (header absent or non-positive, or the
// countdown reached zero) and false when it has already written a simulated 503
// failure to w.
func proxyErrorGate(w http.ResponseWriter, r *http.Request, key string) bool {
	v := strings.TrimSpace(r.Header.Get(proxyErrorHeader))
	if v == "" {
		return true
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		http.Error(w, fmt.Sprintf("%s must be an integer, got %q", proxyErrorHeader, v), http.StatusBadRequest)
		return false
	}
	if n <= 0 {
		return true
	}
	remaining, forward := errorCache.countdown(key, n)
	if forward {
		return true
	}
	writeProxyError(w, key, remaining)
	return false
}

// writeProxyError emits the simulated transient failure: a 503 with a JSON body
// and an X-Proxy-Error-Remaining header reporting how many more attempts remain
// before this key succeeds.
func writeProxyError(w http.ResponseWriter, target string, remaining int) {
	w.Header().Set(proxyRelayHeader, proxyRelayValue)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Proxy-Error-Remaining", strconv.Itoa(remaining))
	w.Header().Set("Retry-After", "0")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error":     "simulated proxy failure",
		"status":    http.StatusServiceUnavailable,
		"target":    target,
		"remaining": remaining,
		"hint":      fmt.Sprintf("retry %d more time(s) for this target to succeed", remaining),
	})
}

// proxyForward relays a plain-HTTP request to its upstream and streams the
// response back to the client, stripping the control and hop-by-hop headers.
func proxyForward(w http.ResponseWriter, r *http.Request) {
	w.Header().Set(proxyRelayHeader, proxyRelayValue)
	out := r.Clone(r.Context())
	out.RequestURI = "" // must be empty on a client (outbound) request
	out.Header.Del(proxyErrorHeader)
	for _, h := range hopHeaders {
		out.Header.Del(h)
	}
	resp, err := proxyTransport.RoundTrip(out)
	if err != nil {
		http.Error(w, "proxy upstream error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	dst := w.Header()
	for k, vals := range resp.Header {
		for _, v := range vals {
			dst.Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// proxyConnect establishes an HTTPS tunnel. The X-PROXY-ERROR countdown is keyed
// by host so HTTPS retries can be exercised too; once it clears, the proxy dials
// the upstream, answers 200 and blindly copies bytes in both directions.
func proxyConnect(w http.ResponseWriter, r *http.Request) {
	if !proxyErrorGate(w, r, "CONNECT "+r.Host) {
		return
	}
	dest, err := net.DialTimeout("tcp", r.Host, 10*time.Second)
	if err != nil {
		http.Error(w, "proxy dial error: "+err.Error(), http.StatusBadGateway)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking unsupported", http.StatusInternalServerError)
		dest.Close()
		return
	}
	client, _, err := hj.Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		dest.Close()
		return
	}
	_, _ = io.WriteString(client,
		"HTTP/1.1 200 Connection Established\r\n"+
			proxyRelayHeader+": "+proxyRelayValue+"\r\n\r\n")
	go tunnel(dest, client)
	go tunnel(client, dest)
}

// tunnel copies bytes from src to dst until EOF then closes both ends; it is run
// once per direction for a CONNECT tunnel.
func tunnel(dst, src net.Conn) {
	defer dst.Close()
	defer src.Close()
	_, _ = io.Copy(dst, src)
}
