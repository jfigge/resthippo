package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"wurl/internal/handler"
	"wurl/internal/store"
)

// ──────────────────────────────────────────────────────────────────────────────
// In-memory mock HistoryStore
// ──────────────────────────────────────────────────────────────────────────────

type mockHistoryStore struct {
	mu        sync.RWMutex
	entries   map[string][]store.HistoryEntry   // requestID → []entry newest-first
	responses map[string]*store.HistoryResponse // "<requestID>/<historyID>" → resp
	addErr    error                             // optional injected error for AddHistory
}

func newMockHistoryStore() *mockHistoryStore {
	return &mockHistoryStore{
		entries:   make(map[string][]store.HistoryEntry),
		responses: make(map[string]*store.HistoryResponse),
	}
}

func (m *mockHistoryStore) seed(entry store.HistoryEntry, resp *store.HistoryResponse) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.entries[entry.RequestID] = append([]store.HistoryEntry{entry}, m.entries[entry.RequestID]...)
	if resp != nil {
		m.responses[entry.RequestID+"/"+entry.ID] = resp
	}
}

func (m *mockHistoryStore) ListHistory(_ context.Context, requestID string, limit int, cursor string) (*store.HistoryPage, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	entries := m.entries[requestID]

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
			return nil, fmt.Errorf("cursor %q not found: %w", cursor, store.ErrNotFound)
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

func (m *mockHistoryStore) AddHistory(_ context.Context, entry *store.HistoryEntry, resp *store.HistoryResponse) error {
	if m.addErr != nil {
		return m.addErr
	}
	if entry.ID == "" {
		entry.ID = "mock-hist-001"
	}
	if entry.Timestamp.IsZero() {
		entry.Timestamp = time.Now().UTC()
	}
	if resp != nil {
		resp.HistoryID = entry.ID
		resp.RequestID = entry.RequestID
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.entries[entry.RequestID] = append([]store.HistoryEntry{*entry}, m.entries[entry.RequestID]...)
	if resp != nil {
		m.responses[entry.RequestID+"/"+entry.ID] = resp
	}
	return nil
}

func (m *mockHistoryStore) GetHistoryResponse(_ context.Context, requestID, historyID string) (*store.HistoryResponse, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	key := requestID + "/" + historyID
	resp, ok := m.responses[key]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *resp
	return &cp, nil
}

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

func makeEntry(id, requestID string, status int) store.HistoryEntry {
	return store.HistoryEntry{
		ID:           id,
		RequestID:    requestID,
		Timestamp:    time.Now().UTC(),
		Status:       status,
		DurationMs:   100,
		ResponseSize: 512,
	}
}

func makeResponse(histID, reqID string) *store.HistoryResponse {
	return &store.HistoryResponse{
		HistoryID:  histID,
		RequestID:  reqID,
		StatusText: "OK",
		Headers:    map[string]string{"Content-Type": "application/json"},
		Body:       `{"hello":"world"}`,
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/requests/{id}/history
// ──────────────────────────────────────────────────────────────────────────────

func TestListHistory(t *testing.T) {
	const reqID = "req-abc-001"

	ms := newMockHistoryStore()
	ms.seed(makeEntry("hist-1", reqID, 200), nil)
	ms.seed(makeEntry("hist-2", reqID, 404), nil)
	ms.seed(makeEntry("hist-3", reqID, 500), nil)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/requests/{id}/history", handler.ListHistory(ms))

	tests := []struct {
		name       string
		reqID      string
		query      string
		wantStatus int
		wantCount  int // expected len(items) in response; -1 to skip
	}{
		{
			name:       "returns all entries (no pagination params)",
			reqID:      reqID,
			wantStatus: http.StatusOK,
			wantCount:  3,
		},
		{
			name:       "limit=1 returns one entry",
			reqID:      reqID,
			query:      "?limit=1",
			wantStatus: http.StatusOK,
			wantCount:  1,
		},
		{
			name:       "unknown request ID returns empty page not 404",
			reqID:      "no-such-req",
			wantStatus: http.StatusOK,
			wantCount:  0,
		},
		{
			name:       "invalid id (dot)",
			reqID:      "req.bad",
			wantStatus: http.StatusBadRequest,
			wantCount:  -1,
		},
		{
			name:       "limit below minimum",
			reqID:      reqID,
			query:      "?limit=0",
			wantStatus: http.StatusBadRequest,
			wantCount:  -1,
		},
		{
			name:       "limit above maximum",
			reqID:      reqID,
			query:      "?limit=101",
			wantStatus: http.StatusBadRequest,
			wantCount:  -1,
		},
		{
			name:       "non-numeric limit",
			reqID:      reqID,
			query:      "?limit=abc",
			wantStatus: http.StatusBadRequest,
			wantCount:  -1,
		},
		{
			name:       "invalid cursor format",
			reqID:      reqID,
			query:      "?cursor=bad.cursor",
			wantStatus: http.StatusBadRequest,
			wantCount:  -1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/requests/"+tc.reqID+"/history"+tc.query, nil)
			rr := httptest.NewRecorder()
			mux.ServeHTTP(rr, req)

			if rr.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d  (body: %s)", rr.Code, tc.wantStatus, rr.Body.String())
			}
			if tc.wantCount >= 0 {
				var page store.HistoryPage
				if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil {
					t.Fatalf("invalid JSON: %v", err)
				}
				if len(page.Items) != tc.wantCount {
					t.Errorf("items count = %d, want %d", len(page.Items), tc.wantCount)
				}
			}
		})
	}
}

func TestListHistoryMetadataOnly(t *testing.T) {
	// The list response must NOT contain response body/headers.
	const reqID = "req-meta-only"
	ms := newMockHistoryStore()
	ms.seed(makeEntry("hist-x", reqID, 200), makeResponse("hist-x", reqID))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/requests/{id}/history", handler.ListHistory(ms))

	req := httptest.NewRequest(http.MethodGet, "/api/requests/"+reqID+"/history", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d", rr.Code)
	}

	var page store.HistoryPage
	if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(page.Items))
	}

	// Verify metadata fields are present.
	e := page.Items[0]
	if e.ID != "hist-x" {
		t.Errorf("id = %q", e.ID)
	}
	if e.Status != 200 {
		t.Errorf("status = %d", e.Status)
	}

	// Verify response payload is NOT embedded in the list entry.
	raw, _ := json.Marshal(page)
	if bytes.Contains(raw, []byte(`"hello"`)) {
		t.Error("list response must not contain response body content")
	}
}

func TestListHistoryPagination(t *testing.T) {
	const reqID = "req-paginate"
	ms := newMockHistoryStore()
	// Seed 5 entries; seed() prepends so last seeded = oldest
	ids := []string{"h1", "h2", "h3", "h4", "h5"}
	for _, id := range ids {
		ms.seed(makeEntry(id, reqID, 200), nil)
	}
	// After seeding: [h5, h4, h3, h2, h1] (newest-first)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/requests/{id}/history", handler.ListHistory(ms))

	// Page 1: limit=2, no cursor → expect [h5, h4], nextCursor="h4"
	req1 := httptest.NewRequest(http.MethodGet, "/api/requests/"+reqID+"/history?limit=2", nil)
	rr1 := httptest.NewRecorder()
	mux.ServeHTTP(rr1, req1)
	if rr1.Code != http.StatusOK {
		t.Fatalf("page1 status = %d", rr1.Code)
	}
	var page1 store.HistoryPage
	if err := json.Unmarshal(rr1.Body.Bytes(), &page1); err != nil {
		t.Fatalf("page1 JSON: %v", err)
	}
	if len(page1.Items) != 2 {
		t.Fatalf("page1 count = %d, want 2", len(page1.Items))
	}
	if page1.Items[0].ID != "h5" || page1.Items[1].ID != "h4" {
		t.Errorf("page1 IDs = [%s, %s], want [h5, h4]", page1.Items[0].ID, page1.Items[1].ID)
	}
	if page1.NextCursor == "" {
		t.Error("page1 nextCursor must not be empty")
	}

	// Page 2: use cursor from page 1
	req2 := httptest.NewRequest(http.MethodGet,
		"/api/requests/"+reqID+"/history?limit=2&cursor="+page1.NextCursor, nil)
	rr2 := httptest.NewRecorder()
	mux.ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusOK {
		t.Fatalf("page2 status = %d (body: %s)", rr2.Code, rr2.Body.String())
	}
	var page2 store.HistoryPage
	if err := json.Unmarshal(rr2.Body.Bytes(), &page2); err != nil {
		t.Fatalf("page2 JSON: %v", err)
	}
	if len(page2.Items) != 2 {
		t.Fatalf("page2 count = %d, want 2", len(page2.Items))
	}
	if page2.Items[0].ID != "h3" || page2.Items[1].ID != "h2" {
		t.Errorf("page2 IDs = [%s, %s], want [h3, h2]", page2.Items[0].ID, page2.Items[1].ID)
	}

	// Page 3: last page → single item, no nextCursor
	req3 := httptest.NewRequest(http.MethodGet,
		"/api/requests/"+reqID+"/history?limit=2&cursor="+page2.NextCursor, nil)
	rr3 := httptest.NewRecorder()
	mux.ServeHTTP(rr3, req3)
	if rr3.Code != http.StatusOK {
		t.Fatalf("page3 status = %d", rr3.Code)
	}
	var page3 store.HistoryPage
	if err := json.Unmarshal(rr3.Body.Bytes(), &page3); err != nil {
		t.Fatalf("page3 JSON: %v", err)
	}
	if len(page3.Items) != 1 || page3.Items[0].ID != "h1" {
		t.Errorf("page3 = %+v, want [h1]", page3.Items)
	}
	if page3.NextCursor != "" {
		t.Errorf("page3 nextCursor = %q, want empty (no more pages)", page3.NextCursor)
	}
}

func TestListHistoryContentType(t *testing.T) {
	ms := newMockHistoryStore()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/requests/{id}/history", handler.ListHistory(ms))

	req := httptest.NewRequest(http.MethodGet, "/api/requests/req-ct/history", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if ct := rr.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/requests/{id}/history
// ──────────────────────────────────────────────────────────────────────────────

func TestAddHistory(t *testing.T) {
	validBody := func(status int) *bytes.Buffer {
		b, _ := json.Marshal(map[string]interface{}{
			"status":       status,
			"statusText":   "OK",
			"durationMs":   150,
			"responseSize": 1024,
			"headers":      map[string]string{"X-Trace": "abc"},
			"body":         `{"result":"ok"}`,
		})
		return bytes.NewBuffer(b)
	}

	tests := []struct {
		name       string
		reqID      string
		body       *bytes.Buffer
		addErr     error
		wantStatus int
		checkID    bool
	}{
		{
			name:       "created",
			reqID:      "req-create-hist",
			body:       validBody(200),
			wantStatus: http.StatusCreated,
			checkID:    true,
		},
		{
			name:       "missing status",
			reqID:      "req-create-hist",
			body:       bytes.NewBufferString(`{"statusText":"OK"}`),
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "invalid JSON body",
			reqID:      "req-create-hist",
			body:       bytes.NewBufferString("not-json"),
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "invalid request id",
			reqID:      "req.bad",
			body:       validBody(200),
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "store error returns 500",
			reqID:      "req-create-hist",
			body:       validBody(200),
			addErr:     fmt.Errorf("disk full"),
			wantStatus: http.StatusInternalServerError,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ms := newMockHistoryStore()
			ms.addErr = tc.addErr
			mux := http.NewServeMux()
			mux.HandleFunc("POST /api/requests/{id}/history", handler.AddHistory(ms))

			req := httptest.NewRequest(http.MethodPost, "/api/requests/"+tc.reqID+"/history", tc.body)
			req.Header.Set("Content-Type", "application/json")
			rr := httptest.NewRecorder()
			mux.ServeHTTP(rr, req)

			if rr.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d  (body: %s)", rr.Code, tc.wantStatus, rr.Body.String())
			}
			if tc.checkID {
				var got store.HistoryEntry
				if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
					t.Fatalf("invalid JSON: %v", err)
				}
				if got.ID == "" {
					t.Error("response must contain a non-empty id")
				}
				if got.RequestID != tc.reqID {
					t.Errorf("requestId = %q, want %q", got.RequestID, tc.reqID)
				}
				if got.Status != 200 {
					t.Errorf("status = %d, want 200", got.Status)
				}
			}
		})
	}
}

func TestAddHistoryResponseBodyNotInMetadata(t *testing.T) {
	// The 201 response must be HistoryEntry (metadata only), NOT HistoryResponse.
	ms := newMockHistoryStore()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/requests/{id}/history", handler.AddHistory(ms))

	b, _ := json.Marshal(map[string]interface{}{
		"status":     201,
		"statusText": "Created",
		"body":       `{"secret":"data"}`,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/requests/req-nometa/history", bytes.NewBuffer(b))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d", rr.Code)
	}
	raw := rr.Body.Bytes()
	if bytes.Contains(raw, []byte("secret")) {
		t.Error("201 response body must not echo back the response payload")
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/requests/{id}/history/{historyId}/response
// ──────────────────────────────────────────────────────────────────────────────

func TestGetHistoryResponse(t *testing.T) {
	const reqID = "req-get-resp"
	const histID = "hist-get-001"

	ms := newMockHistoryStore()
	ms.seed(makeEntry(histID, reqID, 200), makeResponse(histID, reqID))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/requests/{id}/history/{historyId}/response",
		handler.GetHistoryResponse(ms))

	tests := []struct {
		name       string
		reqID      string
		histID     string
		wantStatus int
		checkBody  bool
	}{
		{
			name:       "found",
			reqID:      reqID,
			histID:     histID,
			wantStatus: http.StatusOK,
			checkBody:  true,
		},
		{
			name:       "history not found",
			reqID:      reqID,
			histID:     "no-such-hist",
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "invalid request id",
			reqID:      "req.bad",
			histID:     histID,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "invalid history id",
			reqID:      reqID,
			histID:     "hist.bad",
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			url := fmt.Sprintf("/api/requests/%s/history/%s/response", tc.reqID, tc.histID)
			req := httptest.NewRequest(http.MethodGet, url, nil)
			rr := httptest.NewRecorder()
			mux.ServeHTTP(rr, req)

			if rr.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d  (body: %s)", rr.Code, tc.wantStatus, rr.Body.String())
			}
			if tc.checkBody {
				var resp store.HistoryResponse
				if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
					t.Fatalf("invalid JSON: %v", err)
				}
				if resp.HistoryID != histID {
					t.Errorf("historyId = %q, want %q", resp.HistoryID, histID)
				}
				if resp.Body != `{"hello":"world"}` {
					t.Errorf("body = %q", resp.Body)
				}
				if resp.Headers["Content-Type"] != "application/json" {
					t.Errorf("headers = %v", resp.Headers)
				}
			}
		})
	}
}

func TestGetHistoryResponseLazyLoad(t *testing.T) {
	// The list endpoint must NOT pre-load the response body;
	// the /response endpoint is the only way to get it.
	const reqID = "req-lazy"
	const histID = "hist-lazy"

	ms := newMockHistoryStore()
	ms.seed(makeEntry(histID, reqID, 200), makeResponse(histID, reqID))

	listMux := http.NewServeMux()
	listMux.HandleFunc("GET /api/requests/{id}/history", handler.ListHistory(ms))

	respMux := http.NewServeMux()
	respMux.HandleFunc("GET /api/requests/{id}/history/{historyId}/response",
		handler.GetHistoryResponse(ms))

	// List should not include body.
	listReq := httptest.NewRequest(http.MethodGet, "/api/requests/"+reqID+"/history", nil)
	listRR := httptest.NewRecorder()
	listMux.ServeHTTP(listRR, listReq)
	if bytes.Contains(listRR.Body.Bytes(), []byte(`"hello"`)) {
		t.Error("list response must not contain response body")
	}

	// /response endpoint should contain body.
	respReq := httptest.NewRequest(http.MethodGet,
		fmt.Sprintf("/api/requests/%s/history/%s/response", reqID, histID), nil)
	respRR := httptest.NewRecorder()
	respMux.ServeHTTP(respRR, respReq)
	if !bytes.Contains(respRR.Body.Bytes(), []byte("hello")) {
		t.Error("response endpoint must contain the full response body")
	}
}
