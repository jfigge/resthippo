package fs

import (
	"fmt"
	"os"
	"strings"
	"sync"

	"wurl/internal/store"
)

// resolver maintains an in-memory cache of requestID → collectionID mappings.
//
// The cache is built lazily by scanning the requests/ subdirectory of every
// collection. A nil cache means "not yet built" or "invalidated". Cache misses
// after an initial build trigger a full rebuild, ensuring correctness after
// any write that adds or removes request files.
//
// resolver is safe for concurrent use.
type resolver struct {
	mu    sync.RWMutex
	cache map[string]string // requestID → collectionID; nil = needs rebuild
	paths *paths
}

func newResolver(p *paths) *resolver {
	return &resolver{paths: p}
}

// resolve returns the collectionID for requestID.
// Returns store.ErrNotFound if the request is not in any collection.
func (r *resolver) resolve(requestID string) (string, error) {
	// Fast path: cache hit.
	r.mu.RLock()
	c := r.cache
	r.mu.RUnlock()

	if c != nil {
		if collID, ok := c[requestID]; ok {
			return collID, nil
		}
		// Cache is populated but the ID wasn't found: still try a rebuild
		// in case the file was written by an external process.
	}

	// Build (or rebuild) the cache.
	if err := r.rebuild(); err != nil {
		return "", err
	}

	r.mu.RLock()
	collID, ok := r.cache[requestID]
	r.mu.RUnlock()
	if !ok {
		return "", fmt.Errorf("request %q: %w", requestID, store.ErrNotFound)
	}
	return collID, nil
}

// rebuild scans every collection's requests/ directory and rewrites the cache.
// It uses double-checked locking so only one goroutine does the work.
func (r *resolver) rebuild() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	newCache := make(map[string]string)
	collsDir := r.paths.collectionsDir()

	entries, err := os.ReadDir(collsDir)
	if err != nil {
		if os.IsNotExist(err) {
			r.cache = newCache
			return nil
		}
		return fmt.Errorf("resolver: list collections: %w", err)
	}

	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		collID := e.Name()
		reqsDir := r.paths.requestsDir(collID)

		reqEntries, err := os.ReadDir(reqsDir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return fmt.Errorf("resolver: list requests in %s: %w", collID, err)
		}

		for _, re := range reqEntries {
			name := re.Name()
			if re.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".tmp.json") {
				continue
			}
			reqID := strings.TrimSuffix(name, ".json")
			newCache[reqID] = collID
		}
	}

	r.cache = newCache
	return nil
}

// set adds or updates one mapping without invalidating the whole cache.
// Safe to call only when the cache is already built.
func (r *resolver) set(requestID, collectionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cache != nil {
		r.cache[requestID] = collectionID
	}
}

// remove deletes one mapping without invalidating the whole cache.
func (r *resolver) remove(requestID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cache != nil {
		delete(r.cache, requestID)
	}
}

// invalidate discards the cache so it is rebuilt on the next resolve call.
func (r *resolver) invalidate() {
	r.mu.Lock()
	r.cache = nil
	r.mu.Unlock()
}

// collectionIDs returns a deduplicated list of all known collection IDs.
// Used by HistoryStore when searching for a request across collections.
//
//nolint:unused
func (r *resolver) collectionIDs() ([]string, error) {
	collsDir := r.paths.collectionsDir()
	entries, err := os.ReadDir(collsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("resolver: list collections: %w", err)
	}
	var ids []string
	for _, e := range entries {
		if e.IsDir() {
			ids = append(ids, e.Name())
		}
	}
	return ids, nil
}

// listRequestsInCollection returns all requestIDs stored under a collection.
//
//nolint:unused
func listRequestsInCollection(p *paths, collID string) ([]string, error) {
	reqsDir := p.requestsDir(collID)
	entries, err := os.ReadDir(reqsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("list requests %s: %w", collID, err)
	}
	var ids []string
	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() && strings.HasSuffix(name, ".json") && !strings.Contains(name, ".tmp") {
			ids = append(ids, strings.TrimSuffix(name, ".json"))
		}
	}
	return ids, nil
}

// validateID is a small guard used by each store before path construction.
func validateID(id string, label string) error {
	if id == "" {
		return fmt.Errorf("%s: id must not be empty", label)
	}
	if strings.ContainsAny(id, `/\`) || id == "." || id == ".." {
		return fmt.Errorf("%s: id %q contains illegal characters", label, id)
	}
	return nil
}
