package fs

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"wurl/internal/store"
)

// ──────────────────────────────────────────────────────────────────────────────
// HistoryStore
// ──────────────────────────────────────────────────────────────────────────────

// HistoryStore implements store.HistoryStore using the new per-file layout.
//
// History metadata (one HistoryEntry per file):
//
//	collections/<collID>/history/<requestID>/<historyID>.json
//
// Response payloads (loaded lazily, one file per execution):
//
//	collections/<collID>/responses/<requestID>/<historyID>.json
//
// Listing history for a request scans and reads all entry files in the history
// directory (metadata only, no response bodies), sorts them newest-first by
// embedded Timestamp, then applies cursor-based pagination.
//
// The resolver is used to map requestID → collectionID without scanning all
// collection directories on every call.
type HistoryStore struct {
	p *paths
	r *resolver
}

// ── ListHistory ────────────────────────────────────────────────────────────

// ListHistory returns a cursor-paginated list of history entries for
// requestID, ordered newest-first.
//
// An empty cursor starts from the most recent entry. A non-empty cursor is
// the historyID of the last entry returned on the previous page.
func (s *HistoryStore) ListHistory(_ context.Context, requestID string, limit int, cursor string) (*store.HistoryPage, error) {
	if err := validateID(requestID, "request"); err != nil {
		return nil, err
	}

	collID, err := s.r.resolve(requestID)
	if err != nil {
		// Unknown request → return empty page rather than 404.
		if isNotFound(err) {
			return &store.HistoryPage{Items: []store.HistoryEntry{}}, nil
		}
		return nil, err
	}

	entries, err := s.loadAllEntries(collID, requestID)
	if err != nil {
		return nil, err
	}

	// Sort newest-first.
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Timestamp.After(entries[j].Timestamp)
	})

	// Locate cursor position.
	start := 0
	if cursor != "" {
		found := false
		for i, e := range entries {
			if e.ID == cursor {
				start = i + 1
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("history cursor %q not found: %w", cursor, store.ErrNotFound)
		}
	}

	end := start + limit
	var nextCursor string
	if end < len(entries) {
		nextCursor = entries[end-1].ID
	} else {
		end = len(entries)
	}

	items := make([]store.HistoryEntry, 0, end-start)
	items = append(items, entries[start:end]...)
	return &store.HistoryPage{Items: items, NextCursor: nextCursor}, nil
}

// loadAllEntries reads every history entry file for a request.
func (s *HistoryStore) loadAllEntries(collID, requestID string) ([]store.HistoryEntry, error) {
	dir := s.p.historyDir(collID, requestID)
	des, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []store.HistoryEntry{}, nil
		}
		return nil, fmt.Errorf("history list %s: %w", requestID, err)
	}

	var entries []store.HistoryEntry
	for _, de := range des {
		name := de.Name()
		if de.IsDir() || !strings.HasSuffix(name, ".json") || strings.Contains(name, ".tmp") {
			continue
		}
		histID := strings.TrimSuffix(name, ".json")
		var entry store.HistoryEntry
		if err := readJSON(s.p.historyEntryPath(collID, requestID, histID), &entry); err != nil {
			continue // skip unreadable files
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// ── AddHistory ─────────────────────────────────────────────────────────────

// AddHistory records one execution of a request. IDs and timestamps are
// assigned when missing. The response payload is written separately so that
// ListHistory never has to read large bodies.
func (s *HistoryStore) AddHistory(_ context.Context, entry *store.HistoryEntry, resp *store.HistoryResponse) error {
	if err := validateID(entry.RequestID, "request"); err != nil {
		return err
	}
	if entry.ID == "" {
		entry.ID = newUUID()
	}
	if entry.Timestamp.IsZero() {
		entry.Timestamp = time.Now().UTC()
	}
	resp.HistoryID = entry.ID
	resp.RequestID = entry.RequestID

	collID, err := s.r.resolve(entry.RequestID)
	if err != nil {
		return err
	}

	// Ensure directories exist.
	histDir := s.p.historyDir(collID, entry.RequestID)
	if err := ensureDir(histDir); err != nil {
		return fmt.Errorf("history: mkdir hist: %w", err)
	}
	respDir := s.p.responsesDir(collID, entry.RequestID)
	if err := ensureDir(respDir); err != nil {
		return fmt.Errorf("history: mkdir resp: %w", err)
	}

	// Write response payload first (safe to retry: same path + content).
	if err := writeJSON(s.p.responsePath(collID, entry.RequestID, entry.ID), resp); err != nil {
		return fmt.Errorf("history: write response: %w", err)
	}

	// Write history entry metadata.
	if err := writeJSON(s.p.historyEntryPath(collID, entry.RequestID, entry.ID), entry); err != nil {
		return fmt.Errorf("history: write entry: %w", err)
	}

	return nil
}

// ── GetHistoryResponse ─────────────────────────────────────────────────────

// GetHistoryResponse lazily loads the full response payload for one history
// entry. Returns ErrNotFound if the response file does not exist.
func (s *HistoryStore) GetHistoryResponse(_ context.Context, requestID, historyID string) (*store.HistoryResponse, error) {
	if err := validateID(requestID, "request"); err != nil {
		return nil, err
	}
	if err := validateID(historyID, "history"); err != nil {
		return nil, err
	}

	collID, err := s.r.resolve(requestID)
	if err != nil {
		return nil, err
	}

	var resp store.HistoryResponse
	if err := readJSON(s.p.responsePath(collID, requestID, historyID), &resp); err != nil {
		if os.IsNotExist(err) {
			return nil, store.ErrNotFound
		}
		return nil, fmt.Errorf("history response %s/%s: %w", requestID, historyID, err)
	}
	return &resp, nil
}

// ── helpers ────────────────────────────────────────────────────────────────

// isNotFound reports whether err wraps store.ErrNotFound.
func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), store.ErrNotFound.Error())
}

var _ store.HistoryStore = (*HistoryStore)(nil)
