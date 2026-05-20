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
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"wurl/internal/handler"
	fsstore "wurl/internal/store/fs"
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

	// ── Storage layer ─────────────────────────────────────────────────────────
	// NewStores creates all stores sharing one path layout and one resolver
	// cache (requestID → collectionID).  New filesystem layout:
	//
	//   <dataDir>/collections/
	//     index.json                       – manifest
	//     <collectionID>/
	//       metadata.json                  – name + env-level variables
	//       tree.json                      – lightweight navigation tree
	//       requests/<reqID>.json          – one file per request
	//       history/<reqID>/<histID>.json  – history entry metadata
	//       responses/<reqID>/<histID>.json – response payloads (lazy-loaded)
	ss := fsstore.NewStores(absDataDir)

	// ── Router ────────────────────────────────────────────────────────────────
	mux := http.NewServeMux()

	// Existing collection + environment APIs (unchanged contract).
	mux.HandleFunc("/api/execute", handler.Execute())
	mux.HandleFunc("/api/collections", handler.Collections(ss.CollectionStore()))
	mux.HandleFunc("/api/env", handler.Environment(ss.EnvironmentStore()))

	// Granular request APIs.
	mux.HandleFunc("GET /api/requests/{id}", handler.GetRequest(ss.RequestStore()))
	mux.HandleFunc("POST /api/requests", handler.CreateRequest(ss.RequestStore()))
	mux.HandleFunc("PATCH /api/requests/{id}", handler.PatchRequest(ss.RequestStore()))
	mux.HandleFunc("DELETE /api/requests/{id}", handler.DeleteRequest(ss.RequestStore()))

	// Lightweight collection tree APIs.
	mux.HandleFunc("GET /api/collections/{id}/tree", handler.GetCollectionTree(ss.TreeStore()))
	mux.HandleFunc("PUT /api/collections/{id}/tree", handler.PutCollectionTree(ss.TreeStore()))

	// Request history APIs (metadata + lazy-loaded response payloads).
	mux.HandleFunc("GET /api/requests/{id}/history", handler.ListHistory(ss.HistoryStore()))
	mux.HandleFunc("POST /api/requests/{id}/history", handler.AddHistory(ss.HistoryStore()))
	mux.HandleFunc("GET /api/requests/{id}/history/{historyId}/response", handler.GetHistoryResponse(ss.HistoryStore()))

	// ── Function evaluation ────────────────────────────────────────────────────
	mux.HandleFunc("POST /api/functions/invoke", handler.Functions())

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
