package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"
)

// proxy.go — a small forward proxy used to exercise wurl's proxy settings. It
// runs alongside the main mock API on a separate port and speaks ordinary HTTP
// forward-proxy semantics: clients send absolute-URI requests (plain HTTP) or
// CONNECT (HTTPS tunnel) and the proxy relays them to the real upstream.

const (
	// proxyAddr is the forward-proxy listen address (sibling of the :8888 API).
	proxyAddr = ":9999"
	// proxyRelayHeader is stamped onto every response the proxy controls so a
	// client can tell the request passed through it: forwarded responses and the
	// CONNECT acknowledgement. The tunnelled HTTPS response itself is end-to-end
	// TLS and can't be marked.
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
	proxyForward(w, r)
}

// proxyForward relays a plain-HTTP request to its upstream and streams the
// response back to the client, stripping the hop-by-hop headers.
func proxyForward(w http.ResponseWriter, r *http.Request) {
	w.Header().Set(proxyRelayHeader, proxyRelayValue)
	out := r.Clone(r.Context())
	out.RequestURI = "" // must be empty on a client (outbound) request
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

// proxyConnect establishes an HTTPS tunnel: it dials the upstream, answers 200
// and blindly copies bytes in both directions.
func proxyConnect(w http.ResponseWriter, r *http.Request) {
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
