package main

import (
	"encoding/base64"
	"encoding/binary"
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

// proxy.go — the small proxies that let wurl exercise its proxy and retry
// settings (feature 44). They run alongside the main mock API, each on its own
// port, sharing this process so a single `make mock-up` brings everything up:
//
//	:9999  HTTP/HTTPS forward proxy — absolute-URI requests (plain HTTP) and
//	       CONNECT tunnels (HTTPS), the classic Postman/Insomnia HTTP proxy.
//	:9998  SOCKS5 proxy — the CONNECT command via a dependency-free std-lib
//	       implementation, with optional RFC 1929 username/password auth.
//
// Both honour optional proxy authentication (opt-in via the environment, see
// the proxyAuth* vars). The HTTP forward proxy additionally supports transient
// fault injection via the X-Proxy-Error request header so a client's retry
// policy can be driven end to end — see injectProxyFault.

const (
	// proxyRelayHeader is stamped onto every response the forward proxy controls
	// so a client can tell the request passed through it: forwarded responses,
	// the CONNECT acknowledgement, and the 407/5xx the proxy produces itself. The
	// tunnelled HTTPS response and the SOCKS-relayed bytes are end-to-end and
	// can't be marked — those are verified by the request simply succeeding (and,
	// for bypass-list hosts, by this header being *absent* on a direct connect).
	proxyRelayHeader = "X-Proxy-Relayed"
	// proxyRelayValue identifies this proxy in the relay header.
	proxyRelayValue = "wurl-mock"
	// proxyErrorHeader asks the forward proxy to inject a transient failure so a
	// client retry policy can be exercised. See injectProxyFault for the value
	// grammar ("<n>", "<n>:reset", "<n>:timeout", "<n>:<status>").
	proxyErrorHeader = "X-Proxy-Error"
	// proxyErrorDelayHeader overrides the hang duration (ms) for "timeout"
	// faults (default 1500ms).
	proxyErrorDelayHeader = "X-Proxy-Error-Delay"
)

// Proxy authentication is opt-in via the environment so the default setup needs
// no credentials. When either is set the forward proxy answers 407 until a
// matching Basic Proxy-Authorization arrives, and the SOCKS5 proxy requires an
// RFC 1929 username/password handshake.
//
//	MOCK_PROXY_USER=alice MOCK_PROXY_PASS=s3cret make mock-up
var (
	proxyAuthUser     = os.Getenv("MOCK_PROXY_USER")
	proxyAuthPass     = os.Getenv("MOCK_PROXY_PASS")
	proxyAuthRequired = proxyAuthUser != "" || proxyAuthPass != ""
)

// Listen addresses, overridable via the environment so a single shared dev.env
// (see the Makefile) can move every mock port at once. The HTTP server's own
// address lives in server.go and uses the same helper.
var (
	proxyAddr = listenAddr("MOCK_PROXY_PORT", ":9999") // forward HTTP/HTTPS proxy
	socksAddr = listenAddr("MOCK_SOCKS_PORT", ":9998") // SOCKS5 proxy
)

// listenAddr resolves a listen address from environment variable env, falling
// back to def when unset. A bare port ("9999") is accepted and gains the ":"
// prefix; a value that already contains ":" (":9999" or "host:9999") is used
// verbatim.
func listenAddr(env, def string) string {
	v := strings.TrimSpace(os.Getenv(env))
	if v == "" {
		return def
	}
	if strings.Contains(v, ":") {
		return v
	}
	return ":" + v
}

// hopHeaders are the HTTP hop-by-hop headers a proxy must not forward upstream
// (RFC 7230 §6.1). Proxy-Authorization is among them, so the client's proxy
// credentials never leak past this proxy to the real upstream.
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

// faultCounts tracks, per target URL, how many times the forward proxy has
// injected a fault so X-Proxy-Error can fail a fixed number of times and then
// let the request through. The count resets once a URL succeeds, making a flaky
// scenario repeatable across runs.
var faultCounts = struct {
	sync.Mutex
	n map[string]int
}{n: map[string]int{}}

// startProxyServer runs the forward proxy on proxyAddr and the SOCKS5 proxy on
// socksAddr. It blocks on the forward proxy, so main() launches it in its own
// goroutine; the SOCKS5 proxy gets a goroutine of its own here.
func startProxyServer() {
	go startSocksServer()

	if proxyAuthRequired {
		fmt.Fprintln(os.Stderr, "mock proxy auth required (Basic / SOCKS5 user-pass)")
	}
	srv := &http.Server{Addr: proxyAddr, Handler: http.HandlerFunc(proxyHandler)}
	fmt.Fprintln(os.Stderr, "mock proxy listening on", proxyAddr)
	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintln(os.Stderr, "proxy:", err)
	}
}

// proxyHandler is the forward-proxy entry point: optional proxy auth, then
// CONNECT tunnels for HTTPS, absolute-URI requests for plain HTTP, and a
// friendly 400 for anything that hits the proxy port without going through it.
func proxyHandler(w http.ResponseWriter, r *http.Request) {
	if !checkProxyAuth(w, r) {
		return
	}
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

// checkProxyAuth enforces optional Basic proxy authentication. It returns true
// (writing nothing) when auth is disabled or the Proxy-Authorization credentials
// match; otherwise it answers 407 Proxy Authentication Required and returns
// false so the caller stops.
func checkProxyAuth(w http.ResponseWriter, r *http.Request) bool {
	if !proxyAuthRequired {
		return true
	}
	if user, pass, ok := parseBasicProxyAuth(r.Header.Get("Proxy-Authorization")); ok &&
		user == proxyAuthUser && pass == proxyAuthPass {
		return true
	}
	w.Header().Set("Proxy-Authenticate", `Basic realm="wurl-mock"`)
	w.Header().Set(proxyRelayHeader, proxyRelayValue)
	http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
	return false
}

// parseBasicProxyAuth decodes a "Basic base64(user:pass)" Proxy-Authorization
// value. ok is false when the header is missing or malformed.
func parseBasicProxyAuth(h string) (user, pass string, ok bool) {
	const prefix = "Basic "
	if len(h) < len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return "", "", false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(h[len(prefix):]))
	if err != nil {
		return "", "", false
	}
	user, pass, ok = strings.Cut(string(raw), ":")
	return user, pass, ok
}

// proxyForward relays a plain-HTTP request to its upstream and streams the
// response back to the client, stripping the hop-by-hop headers. When the
// request carries X-Proxy-Error the fault injector may answer instead.
func proxyForward(w http.ResponseWriter, r *http.Request) {
	if injectProxyFault(w, r) {
		return
	}
	w.Header().Set(proxyRelayHeader, proxyRelayValue)
	out := r.Clone(r.Context())
	out.RequestURI = "" // must be empty on a client (outbound) request
	for _, h := range hopHeaders {
		out.Header.Del(h)
	}
	// Never leak the proxy's own control headers to the real upstream.
	out.Header.Del(proxyErrorHeader)
	out.Header.Del(proxyErrorDelayHeader)
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

// injectProxyFault implements the X-Proxy-Error retry-testing hook. A request
// carrying "X-Proxy-Error: <n>[:<mode>]" is failed for its first n-1 deliveries
// to the same target URL and then allowed through, so a client retry policy can
// recover within n attempts. The per-URL count resets once the request succeeds,
// so the scenario repeats on the next run. (Only the plain-HTTP forward path can
// read this header; CONNECT and SOCKS tunnels hide it, by design.)
//
// <mode> selects how the fault surfaces, matching feature 44's retry conditions:
//
//	(omitted) / <status>  HTTP error response (default 502 Bad Gateway); retried
//	                      when the client opts that status into its retry codes.
//	reset                 abruptly close the connection — a connection error,
//	                      retried by default.
//	timeout               hang past the client timeout (X-Proxy-Error-Delay ms,
//	                      default 1500) then close — a timeout, retried by default.
//
// It returns true when it handled the response (fault injected); false means the
// caller should relay the request normally.
func injectProxyFault(w http.ResponseWriter, r *http.Request) bool {
	spec := r.Header.Get(proxyErrorHeader)
	if spec == "" {
		return false
	}
	countStr, mode, _ := strings.Cut(spec, ":")
	n, err := strconv.Atoi(strings.TrimSpace(countStr))
	if err != nil || n < 1 {
		return false // malformed → behave as if the header were absent
	}

	key := r.URL.String()
	faultCounts.Lock()
	faultCounts.n[key]++
	c := faultCounts.n[key]
	if c >= n {
		delete(faultCounts.n, key) // success: reset the counter for the next run
	}
	faultCounts.Unlock()
	if c >= n {
		return false // nth (and later) delivery succeeds — relay normally
	}

	// This is one of the first n-1 deliveries: fail it.
	switch mode = strings.ToLower(strings.TrimSpace(mode)); mode {
	case "reset":
		hijackAndClose(w)
	case "timeout":
		delay := 1500
		if d, err := strconv.Atoi(r.Header.Get(proxyErrorDelayHeader)); err == nil && d > 0 {
			delay = d
		}
		time.Sleep(time.Duration(delay) * time.Millisecond)
		hijackAndClose(w)
	default:
		status := http.StatusBadGateway
		if code, err := strconv.Atoi(mode); err == nil && code >= 100 && code <= 599 {
			status = code
		}
		w.Header().Set(proxyRelayHeader, proxyRelayValue)
		http.Error(w, fmt.Sprintf(
			"simulated proxy fault %d/%d for %s (X-Proxy-Error)", c, n-1, key), status)
	}
	return true
}

// hijackAndClose tears down the client connection without sending a valid HTTP
// response, surfacing as a connection error (or, after a delay, a timeout) on
// the client. It falls back to a 502 when the writer can't be hijacked.
func hijackAndClose(w http.ResponseWriter) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "simulated proxy fault", http.StatusBadGateway)
		return
	}
	conn, _, err := hj.Hijack()
	if err != nil {
		return
	}
	_ = conn.Close()
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
// once per direction for a CONNECT or SOCKS tunnel.
func tunnel(dst, src net.Conn) {
	defer dst.Close()
	defer src.Close()
	_, _ = io.Copy(dst, src)
}

// ── SOCKS5 proxy (RFC 1928 / RFC 1929) ───────────────────────────────────────

// startSocksServer runs the SOCKS5 proxy on socksAddr. It supports the CONNECT
// command only (enough for HTTP/HTTPS over SOCKS) and, when proxy auth is
// configured, the username/password method.
func startSocksServer() {
	ln, err := net.Listen("tcp", socksAddr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "socks:", err)
		return
	}
	fmt.Fprintln(os.Stderr, "mock SOCKS5 proxy listening on", socksAddr)
	for {
		c, err := ln.Accept()
		if err != nil {
			fmt.Fprintln(os.Stderr, "socks accept:", err)
			return
		}
		go serveSocks(c)
	}
}

// serveSocks drives one client connection through method negotiation, optional
// auth, the CONNECT request, and then relays bytes both ways.
func serveSocks(client net.Conn) {
	// A handshake deadline keeps a stalled client from pinning a goroutine; it is
	// cleared once the tunnel is established and relaying begins.
	_ = client.SetDeadline(time.Now().Add(30 * time.Second))

	if !socksNegotiate(client) {
		client.Close()
		return
	}
	dest, ok := socksConnect(client)
	if !ok {
		client.Close()
		return
	}
	_ = client.SetDeadline(time.Time{})
	go tunnel(dest, client)
	go tunnel(client, dest)
}

// socksNegotiate performs the SOCKS5 method-selection handshake (and the
// username/password sub-negotiation when chosen). It returns false on any
// protocol error or rejected authentication.
func socksNegotiate(c net.Conn) bool {
	// VER, NMETHODS, METHODS[NMETHODS]
	hdr := make([]byte, 2)
	if _, err := io.ReadFull(c, hdr); err != nil || hdr[0] != 0x05 {
		return false
	}
	methods := make([]byte, int(hdr[1]))
	if _, err := io.ReadFull(c, methods); err != nil {
		return false
	}
	offered := map[byte]bool{}
	for _, m := range methods {
		offered[m] = true
	}

	const (
		methodNoAuth   = 0x00
		methodUserPass = 0x02
		methodNone     = 0xFF
	)
	if proxyAuthRequired {
		if !offered[methodUserPass] {
			_, _ = c.Write([]byte{0x05, methodNone})
			return false
		}
		_, _ = c.Write([]byte{0x05, methodUserPass})
		return socksUserPassAuth(c)
	}
	// No auth required: prefer no-auth, but accept (and rubber-stamp) the
	// username/password method if that is all the client offers.
	switch {
	case offered[methodNoAuth]:
		_, _ = c.Write([]byte{0x05, methodNoAuth})
		return true
	case offered[methodUserPass]:
		_, _ = c.Write([]byte{0x05, methodUserPass})
		return socksUserPassAuth(c)
	default:
		_, _ = c.Write([]byte{0x05, methodNone})
		return false
	}
}

// socksUserPassAuth runs the RFC 1929 username/password sub-negotiation. When
// proxy auth is configured the credentials must match; otherwise any are
// accepted (the method was offered, so we complete it cleanly).
func socksUserPassAuth(c net.Conn) bool {
	// VER(0x01), ULEN, UNAME, PLEN, PASSWD
	h := make([]byte, 2)
	if _, err := io.ReadFull(c, h); err != nil || h[0] != 0x01 {
		return false
	}
	uname := make([]byte, int(h[1]))
	if _, err := io.ReadFull(c, uname); err != nil {
		return false
	}
	pl := make([]byte, 1)
	if _, err := io.ReadFull(c, pl); err != nil {
		return false
	}
	passwd := make([]byte, int(pl[0]))
	if _, err := io.ReadFull(c, passwd); err != nil {
		return false
	}

	ok := true
	if proxyAuthRequired {
		ok = string(uname) == proxyAuthUser && string(passwd) == proxyAuthPass
	}
	if ok {
		_, _ = c.Write([]byte{0x01, 0x00}) // success
		return true
	}
	_, _ = c.Write([]byte{0x01, 0x01}) // failure
	return false
}

// socksConnect reads a SOCKS5 request, dials the requested host:port for a
// CONNECT, writes the reply, and returns the upstream connection.
func socksConnect(c net.Conn) (net.Conn, bool) {
	// VER, CMD, RSV, ATYP
	h := make([]byte, 4)
	if _, err := io.ReadFull(c, h); err != nil || h[0] != 0x05 {
		return nil, false
	}
	cmd, atyp := h[1], h[3]

	var host string
	switch atyp {
	case 0x01: // IPv4
		b := make([]byte, 4)
		if _, err := io.ReadFull(c, b); err != nil {
			return nil, false
		}
		host = net.IP(b).String()
	case 0x03: // domain name
		l := make([]byte, 1)
		if _, err := io.ReadFull(c, l); err != nil {
			return nil, false
		}
		d := make([]byte, int(l[0]))
		if _, err := io.ReadFull(c, d); err != nil {
			return nil, false
		}
		host = string(d)
	case 0x04: // IPv6
		b := make([]byte, 16)
		if _, err := io.ReadFull(c, b); err != nil {
			return nil, false
		}
		host = net.IP(b).String()
	default:
		socksReply(c, 0x08) // address type not supported
		return nil, false
	}

	pb := make([]byte, 2)
	if _, err := io.ReadFull(c, pb); err != nil {
		return nil, false
	}
	port := binary.BigEndian.Uint16(pb)

	if cmd != 0x01 { // only CONNECT is supported
		socksReply(c, 0x07) // command not supported
		return nil, false
	}
	dest, err := net.DialTimeout("tcp",
		net.JoinHostPort(host, strconv.Itoa(int(port))), 10*time.Second)
	if err != nil {
		socksReply(c, 0x05) // connection refused
		return nil, false
	}
	socksReply(c, 0x00) // succeeded
	return dest, true
}

// socksReply writes a SOCKS5 reply with the given status and a zero IPv4
// bound-address (BND.ADDR 0.0.0.0:0), which clients ignore for CONNECT.
func socksReply(c net.Conn, rep byte) {
	_, _ = c.Write([]byte{0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
}
