// cmd/main.go — Lightweight dev server for IDE-hosted development.
//
// Serves static web assets AND exposes a small REST API for data persistence
// so the front-end can load/save collections without needing Electron.
//
// Usage:
//
//	go run cmd/main.go [-port 8080] [-web ./web] [-data ./data]
package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptrace"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Version and commit are injected at build time via -ldflags.
var (
	version = "dev"
	commit  = "unknown"
)

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

func main() {
	port := flag.Int("port", 8080, "TCP port to listen on")
	webDir := flag.String("web", "./web", "Path to the web directory to serve")
	dataDir := flag.String("data", "../data", "Path to the data directory for persistent storage")
	flag.Parse()

	absWebDir, err := filepath.Abs(*webDir)
	if err != nil {
		log.Fatalf("error: cannot resolve web directory: %v", err)
	}
	if _, err := os.Stat(absWebDir); os.IsNotExist(err) {
		log.Fatalf("error: web directory not found: %s", absWebDir)
	}

	absDataDir, err := filepath.Abs(*dataDir)
	if err != nil {
		log.Fatalf("error: cannot resolve data directory: %v", err)
	}
	if err := os.MkdirAll(absDataDir, 0o755); err != nil {
		log.Fatalf("error: cannot create data directory: %v", err)
	}

	collectionsFile := filepath.Join(absDataDir, "collections.json")

	mux := http.NewServeMux()

	// ── Execute API ───────────────────────────────────────────────────────────
	// POST /api/execute  →  perform an outgoing HTTP request server-side.
	// The browser renderer cannot make arbitrary cross-origin requests, so we
	// proxy the actual call through the Go dev server and return a rich result
	// that mirrors the Electron ipcMain "http:execute" response shape.
	mux.HandleFunc("/api/execute", func(w http.ResponseWriter, r *http.Request) {
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
		// Safe defaults
		desc.FollowRedirects = true
		desc.VerifySSL = true

		if err = json.NewDecoder(r.Body).Decode(&desc); err != nil {
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
		// Hooks fire on the transport goroutines so guard consoleLog with a mutex.
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
			// Log request body with "|" prefix
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
		respHttpVer := "HTTP/1.1"
		if resp.TLS != nil || outReq.URL.Scheme == "https" {
			respHttpVer = "HTTP/2"
		}
		consoleLog = append(consoleLog,
			fmt.Sprintf("< %s %d %s", respHttpVer, resp.StatusCode, statusText),
		)
		for k, vals := range resp.Header {
			for _, v := range vals {
				consoleLog = append(consoleLog, fmt.Sprintf("< %s: %s", k, v))
			}
		}
		consoleLog = append(consoleLog, "<")
		consoleLog = append(consoleLog, "")

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
	})

	// ── Environment Collections API ──────────────────────────────────────────
	// GET  /api/env?id={envId}  →  read <dataDir>/<envId>.json
	// PUT  /api/env?id={envId}  →  atomically overwrite <dataDir>/<envId>.json
	mux.HandleFunc("/api/env", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		envID := r.URL.Query().Get("id")
		if envID == "" {
			http.Error(w, `{"error":"missing id parameter"}`, http.StatusBadRequest)
			return
		}
		// Sanitise: only UUID characters allowed (prevents path traversal)
		for _, c := range envID {
			if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
				(c >= '0' && c <= '9') || c == '-') {
				http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
				return
			}
		}
		envFile := filepath.Join(absDataDir, envID+".json")

		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(envFile)
			if err != nil {
				if os.IsNotExist(err) {
					_, _ = w.Write([]byte(`{"version":1,"collections":[]}`))
					return
				}
				log.Printf("[api] env read error: %v", err)
				http.Error(w, `{"error":"failed to read environment"}`, http.StatusInternalServerError)
				return
			}
			_, _ = w.Write(data)

		case http.MethodPut:
			var payload json.RawMessage
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
				return
			}
			out, err := json.MarshalIndent(payload, "", "  ")
			if err != nil {
				http.Error(w, `{"error":"failed to marshal JSON"}`, http.StatusInternalServerError)
				return
			}
			tmp := envFile + ".tmp"
			if err := os.WriteFile(tmp, out, 0o644); err != nil {
				log.Printf("[api] env write error: %v", err)
				http.Error(w, `{"error":"failed to write environment"}`, http.StatusInternalServerError)
				return
			}
			if err := os.Rename(tmp, envFile); err != nil {
				log.Printf("[api] env rename error: %v", err)
				http.Error(w, `{"error":"failed to commit environment"}`, http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)

		default:
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		}
	})

	// ── Collections API ──────────────────────────────────────────────────────
	// GET  /api/collections  →  read collections.json (v2 manifest); returns defaults on first run
	// PUT  /api/collections  →  atomically overwrite collections.json
	mux.HandleFunc("/api/collections", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(collectionsFile)
			if err != nil {
				if os.IsNotExist(err) {
					// First run — return an empty v2 manifest so the UI bootstraps correctly.
					_, _ = w.Write([]byte(`{"version":2,"environments":[],"activeEnvironmentId":null,"settings":{}}`))
					return
				}
				log.Printf("[api] read error: %v", err)
				http.Error(w, `{"error":"failed to read collections"}`, http.StatusInternalServerError)
				return
			}
			_, _ = w.Write(data)

		case http.MethodPut:
			var payload json.RawMessage
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
				return
			}
			// Re-marshal to normalise whitespace and validate structure.
			out, err := json.MarshalIndent(payload, "", "  ")
			if err != nil {
				http.Error(w, `{"error":"failed to marshal JSON"}`, http.StatusInternalServerError)
				return
			}
			// Write atomically via a temp file + rename.
			tmp := collectionsFile + ".tmp"
			if err := os.WriteFile(tmp, out, 0o644); err != nil {
				log.Printf("[api] write error: %v", err)
				http.Error(w, `{"error":"failed to write collections"}`, http.StatusInternalServerError)
				return
			}
			if err := os.Rename(tmp, collectionsFile); err != nil {
				log.Printf("[api] rename error: %v", err)
				http.Error(w, `{"error":"failed to commit collections"}`, http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)

		default:
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		}
	})

	// ── Static file server (must be registered last) ─────────────────────────
	noCache := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			next.ServeHTTP(w, r)
		})
	}

	mux.Handle("/", noCache(http.FileServer(http.Dir(absWebDir))))

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("wurl dev server %s (%s)", version, commit)
	log.Printf("Serving  web:  %s", absWebDir)
	log.Printf("Serving data:  %s", absDataDir)
	log.Printf("Listening on   http://localhost%s", addr)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
