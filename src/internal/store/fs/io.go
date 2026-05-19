// Package fs provides filesystem-backed implementations of the store interfaces.
//
// New filesystem layout (all paths relative to dataDir):
//
//	collections/
//	  index.json                   – manifest (environments list + settings)
//	  <collectionID>/
//	    metadata.json              – id, name, env-level variables
//	    tree.json                  – lightweight navigation tree (no request data)
//	    requests/
//	      <requestID>.json         – one file per request
//	    history/
//	      <requestID>/
//	        <historyID>.json       – history entry metadata
//	    responses/
//	      <requestID>/
//	        <historyID>.json       – full response payload (lazy-loaded)
package fs

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ── Atomic I/O ─────────────────────────────────────────────────────────────

// atomicWrite writes data to path using write-to-tmp + rename so a crash
// mid-write never leaves a partial file. The parent directory must exist.
func atomicWrite(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("write temp %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("commit %s: %w", path, err)
	}
	return nil
}

// writeJSON marshals v to indented JSON and atomically writes it to path.
func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal %s: %w", path, err)
	}
	return atomicWrite(path, data)
}

// readJSON reads path and unmarshals its contents into v.
// Returns the raw os.ReadFile error so callers can check os.IsNotExist.
func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err // preserve os.IsNotExist for first-run logic
	}
	if err := json.Unmarshal(data, v); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	return nil
}

// ensureDir creates dir (and all parents) if it does not exist.
func ensureDir(dir string) error {
	return os.MkdirAll(dir, 0o755)
}

// ── Path sanitisation ──────────────────────────────────────────────────────

// safePath joins baseDir and id, returning an error if id is empty, contains
// path-separator characters, or if the resulting path would escape baseDir.
// This prevents directory-traversal attacks when IDs come from HTTP requests.
//
//nolint:unused
func safePath(baseDir, id string) (string, error) {
	if id == "" {
		return "", fmt.Errorf("id must not be empty")
	}
	if strings.ContainsAny(id, `/\`) || id == "." || id == ".." {
		return "", fmt.Errorf("id %q contains illegal characters", id)
	}
	joined := filepath.Join(baseDir, id)
	// Confirm the result stays strictly inside baseDir.
	prefix := filepath.Clean(baseDir) + string(filepath.Separator)
	if !strings.HasPrefix(joined+string(filepath.Separator), prefix) {
		return "", fmt.Errorf("id %q escapes base directory", id)
	}
	return joined, nil
}

// ── UUID ───────────────────────────────────────────────────────────────────

// newUUID generates a random UUID v4 using crypto/rand.
func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant bits
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
