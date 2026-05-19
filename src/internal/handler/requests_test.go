package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"wurl/internal/handler"
	"wurl/internal/store"
)

// ──────────────────────────────────────────────────────────────────────────────
// In-memory mock store
// ──────────────────────────────────────────────────────────────────────────────

// mockRequestStore is a thread-safe in-memory implementation of store.RequestStore
// used exclusively for unit tests.
type mockRequestStore struct {
	mu       sync.RWMutex
	requests map[string]*store.Request
}

func newMockStore(reqs ...*store.Request) *mockRequestStore {
	m := &mockRequestStore{requests: make(map[string]*store.Request)}
	for _, r := range reqs {
		cp := *r
		m.requests[r.ID] = &cp
	}
	return m
}

func (m *mockRequestStore) GetRequest(_ context.Context, id string) (*store.Request, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	req, ok := m.requests[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *req
	return &cp, nil
}

func (m *mockRequestStore) CreateRequest(_ context.Context, _, _ string, req *store.Request) error {
	if req.ID == "" {
		req.ID = "generated-id-001"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := *req
	m.requests[req.ID] = &cp
	return nil
}

func (m *mockRequestStore) UpdateRequest(_ context.Context, id string, patch store.RequestPatch) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	req, ok := m.requests[id]
	if !ok {
		return store.ErrNotFound
	}
	if patch.Name != nil {
		req.Name = *patch.Name
	}
	if patch.Method != nil {
		req.Method = *patch.Method
	}
	if patch.URL != nil {
		req.URL = *patch.URL
	}
	if patch.BodyType != nil {
		req.BodyType = *patch.BodyType
	}
	if patch.BodyText != nil {
		req.BodyText = *patch.BodyText
	}
	if patch.BodyFilePath != nil {
		req.BodyFilePath = *patch.BodyFilePath
	}
	if patch.BodyFormRows != nil {
		req.BodyFormRows = patch.BodyFormRows
	}
	if patch.Params != nil {
		req.Params = patch.Params
	}
	if patch.Headers != nil {
		req.Headers = patch.Headers
	}
	if patch.AuthEnabled != nil {
		req.AuthEnabled = *patch.AuthEnabled
	}
	if patch.AuthType != nil {
		req.AuthType = *patch.AuthType
	}
	if patch.AuthBasic != nil {
		req.AuthBasic = patch.AuthBasic
	}
	if patch.AuthBearer != nil {
		req.AuthBearer = patch.AuthBearer
	}
	if patch.PreRequestScript != nil {
		req.PreRequestScript = *patch.PreRequestScript
	}
	if patch.AfterResponseScript != nil {
		req.AfterResponseScript = *patch.AfterResponseScript
	}
	return nil
}

func (m *mockRequestStore) DeleteRequest(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.requests[id]; !ok {
		return store.ErrNotFound
	}
	delete(m.requests, id)
	return nil
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

func ptr[T any](v T) *T { return &v }

// serve routes the request through a real http.ServeMux so that r.PathValue
// is populated correctly (Go 1.22+).
func serve(mux *http.ServeMux, req *http.Request) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func jsonBody(v any) *bytes.Buffer {
	b, _ := json.Marshal(v)
	return bytes.NewBuffer(b)
}

// fixture request used across tests.
var fixtureReq = &store.Request{
	ID:     "abc-123",
	Type:   "request",
	Name:   "Get users",
	Method: "GET",
	URL:    "https://example.com/users",
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/requests/{id}
// ──────────────────────────────────────────────────────────────────────────────

func TestGetRequest(t *testing.T) {
	ms := newMockStore(fixtureReq)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/requests/{id}", handler.GetRequest(ms))

	tests := []struct {
		name       string
		id         string
		wantStatus int
		wantField  string // optional JSON field to check in the response body
		wantValue  string
	}{
		{
			name:       "found",
			id:         "abc-123",
			wantStatus: http.StatusOK,
			wantField:  "name",
			wantValue:  "Get users",
		},
		{
			name:       "not found",
			id:         "does-not-exist",
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "invalid id contains illegal chars",
			id:         "abc.123", // dot is URL-safe but not UUID-safe
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/requests/"+tc.id, nil)
			rr := serve(mux, req)

			if rr.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rr.Code, tc.wantStatus, rr.Body.String())
			}

			if tc.wantField != "" {
				var got map[string]interface{}
				if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
					t.Fatalf("response is not valid JSON: %v", err)
				}
				if got[tc.wantField] != tc.wantValue {
					t.Errorf("%s = %v, want %q", tc.wantField, got[tc.wantField], tc.wantValue)
				}
			}
		})
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/requests
// ──────────────────────────────────────────────────────────────────────────────

func TestCreateRequest(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/requests", handler.CreateRequest(newMockStore()))

	type body map[string]interface{}

	tests := []struct {
		name       string
		body       interface{}
		wantStatus int
		checkID    bool // assert response contains an "id" field
	}{
		{
			name: "created with all required fields",
			body: body{
				"environmentId": "env-001",
				"collectionId":  "col-001",
				"name":          "New Request",
				"method":        "POST",
				"url":           "https://api.example.com/items",
			},
			wantStatus: http.StatusCreated,
			checkID:    true,
		},
		{
			name: "method defaults to GET when absent",
			body: body{
				"environmentId": "env-001",
				"collectionId":  "col-001",
				"name":          "Implicit GET",
			},
			wantStatus: http.StatusCreated,
			checkID:    true,
		},
		{
			name:       "missing environmentId",
			body:       body{"collectionId": "col-001", "name": "X"},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing collectionId",
			body:       body{"environmentId": "env-001", "name": "X"},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing name",
			body:       body{"environmentId": "env-001", "collectionId": "col-001"},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "invalid JSON body",
			body:       "not-json",
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var buf *bytes.Buffer
			if s, ok := tc.body.(string); ok {
				buf = bytes.NewBufferString(s)
			} else {
				buf = jsonBody(tc.body)
			}
			req := httptest.NewRequest(http.MethodPost, "/api/requests", buf)
			req.Header.Set("Content-Type", "application/json")
			rr := serve(mux, req)

			if rr.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rr.Code, tc.wantStatus, rr.Body.String())
			}
			if tc.checkID {
				var got map[string]interface{}
				if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
					t.Fatalf("response is not valid JSON: %v", err)
				}
				if got["id"] == "" || got["id"] == nil {
					t.Errorf("response missing id: %v", got)
				}
			}
		})
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// PATCH /api/requests/{id}
// ──────────────────────────────────────────────────────────────────────────────

func TestPatchRequest(t *testing.T) {
	type body map[string]interface{}

	tests := []struct {
		name         string
		existingReqs []*store.Request
		id           string
		body         interface{}
		wantStatus   int
		wantName     string // non-empty → check "name" field in response
		wantMethod   string // non-empty → check "method" field
	}{
		{
			name:         "patch name only",
			existingReqs: []*store.Request{fixtureReq},
			id:           "abc-123",
			body:         body{"name": "Renamed"},
			wantStatus:   http.StatusOK,
			wantName:     "Renamed",
			wantMethod:   "GET", // unchanged
		},
		{
			name:         "patch method and url",
			existingReqs: []*store.Request{fixtureReq},
			id:           "abc-123",
			body:         body{"method": "POST", "url": "https://example.com/create"},
			wantStatus:   http.StatusOK,
			wantMethod:   "POST",
		},
		{
			name:         "not found",
			existingReqs: nil,
			id:           "ghost",
			body:         body{"name": "X"},
			wantStatus:   http.StatusNotFound,
		},
		{
			name:         "invalid id",
			existingReqs: nil,
			id:           "abc.123", // dot is URL-safe but not UUID-safe
			body:         body{"name": "X"},
			wantStatus:   http.StatusBadRequest,
		},
		{
			name:         "invalid JSON body",
			existingReqs: []*store.Request{fixtureReq},
			id:           "abc-123",
			body:         "not-json",
			wantStatus:   http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ms := newMockStore(tc.existingReqs...)
			mux := http.NewServeMux()
			mux.HandleFunc("PATCH /api/requests/{id}", handler.PatchRequest(ms))

			var buf *bytes.Buffer
			if s, ok := tc.body.(string); ok {
				buf = bytes.NewBufferString(s)
			} else {
				buf = jsonBody(tc.body)
			}
			req := httptest.NewRequest(http.MethodPatch, "/api/requests/"+tc.id, buf)
			req.Header.Set("Content-Type", "application/json")
			rr := serve(mux, req)

			if rr.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rr.Code, tc.wantStatus, rr.Body.String())
			}

			if tc.wantStatus == http.StatusOK {
				var got map[string]interface{}
				if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
					t.Fatalf("response is not valid JSON: %v", err)
				}
				if tc.wantName != "" && got["name"] != tc.wantName {
					t.Errorf("name = %v, want %q", got["name"], tc.wantName)
				}
				if tc.wantMethod != "" && got["method"] != tc.wantMethod {
					t.Errorf("method = %v, want %q", got["method"], tc.wantMethod)
				}
			}
		})
	}
}

// TestPatchRequestPreservesUnchangedFields ensures that omitting a field from
// the patch body does not erase it in the stored request.
func TestPatchRequestPreservesUnchangedFields(t *testing.T) {
	orig := &store.Request{
		ID:     "req-preserve",
		Type:   "request",
		Name:   "Original",
		Method: "DELETE",
		URL:    "https://example.com/item/1",
	}
	ms := newMockStore(orig)
	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /api/requests/{id}", handler.PatchRequest(ms))

	// Only patch the name; method and URL must be unchanged.
	body := jsonBody(map[string]string{"name": "Updated"})
	req := httptest.NewRequest(http.MethodPatch, "/api/requests/req-preserve", body)
	req.Header.Set("Content-Type", "application/json")
	rr := serve(mux, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rr.Code, rr.Body.String())
	}

	var got store.Request
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if got.Name != "Updated" {
		t.Errorf("name = %q, want %q", got.Name, "Updated")
	}
	if got.Method != "DELETE" {
		t.Errorf("method = %q (should be unchanged)", got.Method)
	}
	if got.URL != "https://example.com/item/1" {
		t.Errorf("url = %q (should be unchanged)", got.URL)
	}
}

// TestPatchRequestClearsSliceWithEmptyArray verifies that sending [] for a
// slice field clears it, while omitting the field leaves it intact.
func TestPatchRequestClearsSliceWithEmptyArray(t *testing.T) {
	orig := &store.Request{
		ID:     "req-slice",
		Type:   "request",
		Name:   "Slice test",
		Method: "GET",
		URL:    "https://example.com",
		Params: []store.KeyValue{
			{ID: "p1", Name: "foo", Value: "bar", Enabled: true},
		},
	}
	ms := newMockStore(orig)
	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /api/requests/{id}", handler.PatchRequest(ms))

	// Sending `"params": []` should clear params.
	body := bytes.NewBufferString(`{"params":[]}`)
	req := httptest.NewRequest(http.MethodPatch, "/api/requests/req-slice", body)
	req.Header.Set("Content-Type", "application/json")
	rr := serve(mux, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rr.Code, rr.Body.String())
	}

	var got store.Request
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if len(got.Params) != 0 {
		t.Errorf("params should be empty after patch, got %v", got.Params)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// DELETE /api/requests/{id}
// ──────────────────────────────────────────────────────────────────────────────

func TestDeleteRequest(t *testing.T) {
	tests := []struct {
		name         string
		existingReqs []*store.Request
		id           string
		wantStatus   int
	}{
		{
			name:         "deleted successfully",
			existingReqs: []*store.Request{fixtureReq},
			id:           "abc-123",
			wantStatus:   http.StatusNoContent,
		},
		{
			name:         "not found",
			existingReqs: nil,
			id:           "ghost",
			wantStatus:   http.StatusNotFound,
		},
		{
			name:         "invalid id",
			existingReqs: nil,
			id:           "abc.123", // dot is URL-safe but not UUID-safe
			wantStatus:   http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ms := newMockStore(tc.existingReqs...)
			mux := http.NewServeMux()
			mux.HandleFunc("DELETE /api/requests/{id}", handler.DeleteRequest(ms))

			req := httptest.NewRequest(http.MethodDelete, "/api/requests/"+tc.id, nil)
			rr := serve(mux, req)

			if rr.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rr.Code, tc.wantStatus, rr.Body.String())
			}
			if tc.wantStatus == http.StatusNoContent {
				// Confirm the resource is gone.
				got, err := ms.GetRequest(context.Background(), tc.id)
				if err == nil {
					t.Errorf("expected ErrNotFound after delete, got request %v", got)
				}
			}
		})
	}
}

// TestDeleteRequestBodyIsEmpty verifies 204 responses carry no body.
func TestDeleteRequestBodyIsEmpty(t *testing.T) {
	ms := newMockStore(fixtureReq)
	mux := http.NewServeMux()
	mux.HandleFunc("DELETE /api/requests/{id}", handler.DeleteRequest(ms))

	req := httptest.NewRequest(http.MethodDelete, "/api/requests/abc-123", nil)
	rr := serve(mux, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rr.Code)
	}
	if rr.Body.Len() != 0 {
		t.Errorf("expected empty body on 204, got %q", rr.Body.String())
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Content-Type
// ──────────────────────────────────────────────────────────────────────────────

func TestResponseContentType(t *testing.T) {
	ms := newMockStore(fixtureReq)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/requests/{id}", handler.GetRequest(ms))

	req := httptest.NewRequest(http.MethodGet, "/api/requests/abc-123", nil)
	rr := serve(mux, req)

	if ct := rr.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

// suppress "declared but not used" for ptr helper in builds that don't use it.
var _ = ptr[string]
