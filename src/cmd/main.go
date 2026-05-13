// cmd/server/main.go — Lightweight static file server for IDE-hosted development.
// Usage: go run cmd/server/main.go [-port 8080] [-web ./web]
package main

import (
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
	flag.Parse()

	absWebDir, err := filepath.Abs(*webDir)
	if err != nil {
		log.Fatalf("error: cannot resolve web directory: %v", err)
	}

	if _, err := os.Stat(absWebDir); os.IsNotExist(err) {
		log.Fatalf("error: web directory not found: %s", absWebDir)
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir(absWebDir)))

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("wurl dev server %s (%s)", version, commit)
	log.Printf("Serving %s", absWebDir)
	log.Printf("Listening on http://localhost%s", addr)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
