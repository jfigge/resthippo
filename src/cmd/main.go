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
	"net/http"
	"os"
	"path/filepath"
	"strings"
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
		consoleLog = append(consoleLog, fmt.Sprintf("* Connecting to %s", desc.URL))

		// ── Build HTTP client ─────────────────────────────────────────────────
		transport := &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: !desc.VerifySSL, //nolint:gosec
			},
		}

		var redirectCount int
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
				redirectCount++
				consoleLog = append(consoleLog,
					fmt.Sprintf("* Redirect %d → %s", redirectCount, req.URL),
					fmt.Sprintf("> %s %s HTTP/1.1", req.Method, req.URL.RequestURI()),
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

		// ── Log outgoing request ──────────────────────────────────────────────
		consoleLog = append(consoleLog,
			fmt.Sprintf("> %s %s HTTP/1.1", strings.ToUpper(desc.Method), outReq.URL.RequestURI()),
			fmt.Sprintf("> Host: %s", outReq.URL.Host),
		)
		for k, vals := range outReq.Header {
			for _, v := range vals {
				consoleLog = append(consoleLog, fmt.Sprintf("> %s: %s", k, v))
			}
		}
		consoleLog = append(consoleLog, ">")

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

		consoleLog = append(consoleLog,
			fmt.Sprintf("< HTTP/1.1 %d %s", resp.StatusCode, statusText),
		)
		for k, vals := range resp.Header {
			for _, v := range vals {
				consoleLog = append(consoleLog, fmt.Sprintf("< %s: %s", k, v))
			}
		}
		consoleLog = append(consoleLog, "<")

		bodyBytes, _ := io.ReadAll(resp.Body)
		size := len(bodyBytes)
		consoleLog = append(consoleLog,
			fmt.Sprintf("* Received %d bytes in %dms", size, elapsed),
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

	// ── Collections API ──────────────────────────────────────────────────────
	// GET  /api/collections  →  read collections.json; returns [] on first run
	// PUT  /api/collections  →  atomically overwrite collections.json
	mux.HandleFunc("/api/collections", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch r.Method {
		case http.MethodGet:
			data, err := os.ReadFile(collectionsFile)
			if err != nil {
				if os.IsNotExist(err) {
					// First run — return an empty set so the UI starts blank.
					_, _ = w.Write([]byte(`{"version":1,"collections":[]}`))
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
