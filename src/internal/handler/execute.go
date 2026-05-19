package handler

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync"
	"time"
)

// Execute returns an http.HandlerFunc that handles the /api/execute endpoint.
//
// The renderer process cannot make arbitrary cross-origin requests; this handler
// proxies the outgoing HTTP call through the Go server and returns a rich result
// that mirrors the Electron ipcMain "http:execute" response shape.
// It has no storage dependency.
func Execute() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}

		// ── Parse JSON descriptor ─────────────────────────────────────────────
		var desc struct {
			Method          string            `json:"method"`
			URL             string            `json:"url"`
			Headers         map[string]string `json:"headers"`
			Body            string            `json:"body"`
			Timeout         int               `json:"timeout"` // ms; 0 → 30 s
			FollowRedirects bool              `json:"followRedirects"`
			VerifySSL       bool              `json:"verifySsl"`
		}
		// Safe defaults.
		desc.FollowRedirects = true
		desc.VerifySSL = true

		if err := json.NewDecoder(r.Body).Decode(&desc); err != nil {
			http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
			return
		}
		if desc.Method == "" {
			desc.Method = "GET"
		}
		timeout := time.Duration(desc.Timeout) * time.Millisecond
		if timeout <= 0 {
			timeout = 30 * time.Second
		}

		consoleLog := []string{}
		consoleLog = append(consoleLog, fmt.Sprintf("* Preparing request to %s", desc.URL))
		consoleLog = append(consoleLog, fmt.Sprintf("* Current time is %s", time.Now().UTC().Format("2006-01-02T15:04:05.000Z")))
		consoleLog = append(consoleLog, "* Enable automatic URL encoding")
		consoleLog = append(consoleLog, "* Using default HTTP version")
		consoleLog = append(consoleLog, fmt.Sprintf("* Enable timeout of %dms", timeout.Milliseconds()))
		if !desc.VerifySSL {
			consoleLog = append(consoleLog, "* Disable SSL validation")
		} else {
			consoleLog = append(consoleLog, "* Enable SSL validation")
		}

		// ── Build HTTP client ─────────────────────────────────────────────────
		transport := &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: !desc.VerifySSL, //nolint:gosec
			},
		}
		client := &http.Client{
			Timeout:   timeout,
			Transport: transport,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if !desc.FollowRedirects {
					return http.ErrUseLastResponse
				}
				if len(via) >= 10 {
					return fmt.Errorf("stopped after 10 redirects")
				}
				redirectURL := req.URL
				prevHost := ""
				if len(via) > 0 {
					prevHost = via[len(via)-1].URL.Hostname()
				}
				if prevHost == "" {
					prevHost = redirectURL.Hostname()
				}
				httpVer := "HTTP/1.1"
				if redirectURL.Scheme == "https" {
					httpVer = "HTTP/2"
				}
				consoleLog = append(consoleLog,
					fmt.Sprintf("* Connection to host %s left intact", prevHost),
					fmt.Sprintf("* Issue another request to this URL: '%s'", redirectURL),
				)
				if req.Method == "GET" && len(via) > 0 && via[len(via)-1].Method != "GET" {
					consoleLog = append(consoleLog, "* Switch to GET")
				}
				consoleLog = append(consoleLog,
					fmt.Sprintf("> %s %s %s", req.Method, req.URL.RequestURI(), httpVer),
					fmt.Sprintf("> Host: %s", req.URL.Host),
					">",
				)
				return nil
			},
		}

		// ── Build the outgoing request ────────────────────────────────────────
		var bodyReader io.Reader
		if desc.Body != "" {
			bodyReader = bytes.NewBufferString(desc.Body)
		}
		outReq, err := http.NewRequest(strings.ToUpper(desc.Method), desc.URL, bodyReader)
		if err != nil {
			consoleLog = append(consoleLog, fmt.Sprintf("* Request build error: %s", err))
			writeExecuteError(w, 0, "", consoleLog, "RequestError", err.Error())
			return
		}
		for k, v := range desc.Headers {
			outReq.Header.Set(k, v)
		}

		// ── Attach connection trace ───────────────────────────────────────────
		var traceMu sync.Mutex
		appendTrace := func(msg string) {
			traceMu.Lock()
			consoleLog = append(consoleLog, msg)
			traceMu.Unlock()
		}
		requestHost := outReq.URL.Hostname()
		trace := &httptrace.ClientTrace{
			DNSStart: func(info httptrace.DNSStartInfo) {
				appendTrace(fmt.Sprintf("* Trying to resolve host '%s'...", info.Host))
			},
			DNSDone: func(info httptrace.DNSDoneInfo) {
				if info.Err != nil {
					appendTrace(fmt.Sprintf("* Could not resolve host '%s': %s", requestHost, info.Err))
				} else {
					addrs := make([]string, 0, len(info.Addrs))
					for _, a := range info.Addrs {
						addrs = append(addrs, a.String())
					}
					appendTrace(fmt.Sprintf("* Resolved '%s' → %s", requestHost, strings.Join(addrs, ", ")))
				}
			},
			ConnectStart: func(network, addr string) {
				appendTrace(fmt.Sprintf("* Trying %s...", addr))
			},
			ConnectDone: func(network, addr string, err error) {
				if err != nil {
					appendTrace(fmt.Sprintf("* Failed to connect to %s: %s", addr, err))
				} else {
					host, port, _ := net.SplitHostPort(addr)
					appendTrace(fmt.Sprintf("* Connected to %s (%s) port %s", requestHost, host, port))
				}
			},
			TLSHandshakeStart: func() {
				appendTrace(fmt.Sprintf("* Performing TLS handshake with '%s'...", requestHost))
			},
			TLSHandshakeDone: func(state tls.ConnectionState, err error) {
				if err != nil {
					appendTrace(fmt.Sprintf("* TLS handshake failed: %s", err))
				} else {
					appendTrace(fmt.Sprintf("* SSL connection using %s / %s",
						tls.VersionName(state.Version),
						tls.CipherSuiteName(state.CipherSuite),
					))
					if state.NegotiatedProtocol != "" {
						appendTrace(fmt.Sprintf("* ALPN: server accepted '%s'", state.NegotiatedProtocol))
					}
				}
			},
			WroteHeaderField: func(key string, value []string) {
				for _, v := range value {
					appendTrace(fmt.Sprintf("> %s: %s", key, v))
				}
				appendTrace(">")
			},
			WroteHeaders: func() {
				if desc.Body != "" {
					appendTrace("* Finished writing request headers and body")
				} else {
					appendTrace("* Finished writing request headers")
				}
			},
			WroteRequest: func(info httptrace.WroteRequestInfo) {
				if info.Err != nil {
					appendTrace(fmt.Sprintf("* Error writing request: %s", info.Err))
				} else {
					appendTrace("* Request write complete")
				}
			},
		}
		outReq = outReq.WithContext(httptrace.WithClientTrace(r.Context(), trace))

		// ── Log outgoing request ──────────────────────────────────────────────
		{
			httpVer := "HTTP/1.1"
			if outReq.URL.Scheme == "https" {
				httpVer = "HTTP/2"
			}
			consoleLog = append(consoleLog,
				fmt.Sprintf("> %s %s %s", strings.ToUpper(desc.Method), outReq.URL.RequestURI(), httpVer),
				fmt.Sprintf("> Host: %s", outReq.URL.Host),
			)
			for k, vals := range outReq.Header {
				for _, v := range vals {
					consoleLog = append(consoleLog, fmt.Sprintf("> %s: %s", k, v))
				}
			}
			consoleLog = append(consoleLog, ">")
			if desc.Body != "" {
				consoleLog = append(consoleLog, "")
				for _, line := range strings.Split(desc.Body, "\n") {
					consoleLog = append(consoleLog, "| "+line)
				}
				consoleLog = append(consoleLog, "")
				consoleLog = append(consoleLog, "* We are completely uploaded and fine")
			}
		}

		// ── Execute ───────────────────────────────────────────────────────────
		start := time.Now()
		resp, err := client.Do(outReq)
		elapsed := time.Since(start).Milliseconds()

		if err != nil {
			consoleLog = append(consoleLog, fmt.Sprintf("* %s", err))
			writeExecuteError(w, 0, "", consoleLog, "NetworkError", err.Error())
			return
		}
		defer func() { _ = resp.Body.Close() }()

		// ── Log incoming response ─────────────────────────────────────────────
		statusText := resp.Status
		if len(statusText) > 4 {
			statusText = statusText[4:] // "200 OK" → "OK"
		}
		respHTTPVer := "HTTP/1.1"
		if resp.TLS != nil || outReq.URL.Scheme == "https" {
			respHTTPVer = "HTTP/2"
		}
		consoleLog = append(consoleLog, fmt.Sprintf("< %s %d %s", respHTTPVer, resp.StatusCode, statusText))
		for k, vals := range resp.Header {
			for _, v := range vals {
				consoleLog = append(consoleLog, fmt.Sprintf("< %s: %s", k, v))
			}
		}
		consoleLog = append(consoleLog, "<", "")

		bodyBytes, _ := io.ReadAll(resp.Body)
		size := len(bodyBytes)
		consoleLog = append(consoleLog,
			fmt.Sprintf("* Received %d B chunk", size),
			fmt.Sprintf("* Connection to host %s left intact", outReq.URL.Hostname()),
		)

		// ── Flatten response headers ──────────────────────────────────────────
		flatHdrs := map[string]string{}
		for k, vals := range resp.Header {
			flatHdrs[k] = strings.Join(vals, ", ")
		}

		// ── Extract Set-Cookie values ─────────────────────────────────────────
		cookies := resp.Header["Set-Cookie"]
		if cookies == nil {
			cookies = []string{}
		}

		// ── Write result ──────────────────────────────────────────────────────
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status":     resp.StatusCode,
			"statusText": statusText,
			"headers":    flatHdrs,
			"cookies":    cookies,
			"body":       string(bodyBytes),
			"elapsed":    elapsed,
			"size":       size,
			"consoleLog": consoleLog,
		})
	}
}

// writeExecuteError writes a JSON error result for the /api/execute endpoint.
func writeExecuteError(w http.ResponseWriter, status int, statusText string, consoleLog []string, errName, errMsg string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     status,
		"statusText": statusText,
		"headers":    map[string]string{},
		"cookies":    []string{},
		"body":       "",
		"elapsed":    int64(0),
		"size":       0,
		"consoleLog": consoleLog,
		"error":      map[string]string{"name": errName, "message": errMsg},
	})
}
