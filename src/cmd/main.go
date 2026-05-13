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
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

// Version and commit are injected at build time via -ldflags.
var (
	version = "dev"
	commit  = "unknown"
)

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
