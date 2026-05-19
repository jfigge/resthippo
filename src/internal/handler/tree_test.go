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

	"wurl/internal/handler"
	"wurl/internal/store"
)

// ──────────────────────────────────────────────────────────────────────────────
// In-memory mock TreeStore
// ──────────────────────────────────────────────────────────────────────────────

type mockTreeStore struct {
	mu      sync.RWMutex
	trees   map[string]*store.CollectionTree
	saveErr error // optional error injected for SaveTree calls
}

func newMockTreeStore(envID string, tree *store.CollectionTree) *mockTreeStore {
	m := &mockTreeStore{trees: make(map[string]*store.CollectionTree)}
	if envID != "" && tree != nil {
		m.trees[envID] = tree
	}
	return m
}

func (m *mockTreeStore) GetTree(_ context.Context, envID string) (*store.CollectionTree, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	tree, ok := m.trees[envID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return tree, nil
}

func (m *mockTreeStore) SaveTree(_ context.Context, envID string, tree *store.CollectionTree) error {
	if m.saveErr != nil {
		return m.saveErr
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := *tree
	m.trees[envID] = &cp
	return nil
}

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

// sampleTree returns a two-level tree used across multiple test cases.
func sampleTree() *store.CollectionTree {
	return &store.CollectionTree{
		Children: []store.TreeNode{
			{
				ID:   "folder-auth",
				Type: "folder",
				Name: "Auth",
				Children: []store.TreeNode{
					{ID: "req-001", Type: "requestRef"},
					{ID: "req-002", Type: "requestRef"},
				},
			},
			{
				ID:   "folder-users",
				Type: "folder",
				Name: "Users",
				Children: []store.TreeNode{
					{ID: "req-003", Type: "requestRef"},
				},
			},
		},
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/collections/{id}/tree
// ──────────────────────────────────────────────────────────────────────────────

func TestGetCollectionTree(t *testing.T) {
	const envID = "env-abc-123"
	ms := newMockTreeStore(envID, sampleTree())

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/collections/{id}/tree", handler.GetCollectionTree(ms))

	tests := []struct {
		name       string
		id         string
		wantStatus int
	}{
		{name: "found", id: envID, wantStatus: http.StatusOK},
		{name: "not found", id: "does-not-exist", wantStatus: http.StatusNotFound},
		{name: "invalid id (dot)", id: "env.abc", wantStatus: http.StatusBadRequest},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/collections/"+tc.id+"/tree", nil)
			rr := httptest.NewRecorder()
			mux.ServeHTTP(rr, req)

			if rr.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d  (body: %s)", rr.Code, tc.wantStatus, rr.Body.String())
			}
		})
	}
}

func TestGetCollectionTreeShape(t *testing.T) {
	const envID = "env-shape"
	ms := newMockTreeStore(envID, sampleTree())

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/collections/{id}/tree", handler.GetCollectionTree(ms))

	req := httptest.NewRequest(http.MethodGet, "/api/collections/"+envID+"/tree", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d (body: %s)", rr.Code, rr.Body.String())
	}

	var got store.CollectionTree
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}

	if len(got.Children) != 2 {
		t.Fatalf("top-level children = %d, want 2", len(got.Children))
	}

	// First folder
	f := got.Children[0]
	if f.Type != "folder" {
		t.Errorf("children[0].type = %q, want folder", f.Type)
	}
	if f.Name != "Auth" {
		t.Errorf("children[0].name = %q, want Auth", f.Name)
	}
	if len(f.Children) != 2 {
		t.Errorf("children[0].children count = %d, want 2", len(f.Children))
	}

	// requestRef inside folder
	ref := f.Children[0]
	if ref.Type != "requestRef" {
		t.Errorf("ref.type = %q, want requestRef", ref.Type)
	}
	if ref.ID != "req-001" {
		t.Errorf("ref.id = %q, want req-001", ref.ID)
	}
	// requestRef must not carry name or children in the JSON output
	if ref.Name != "" {
		t.Errorf("requestRef.name should be empty, got %q", ref.Name)
	}
	if len(ref.Children) != 0 {
		t.Errorf("requestRef.children should be absent/empty, got %v", ref.Children)
	}
}

func TestGetCollectionTreeEmptyEnvironment(t *testing.T) {
	ms := newMockTreeStore("env-empty", &store.CollectionTree{
		Children: []store.TreeNode{},
	})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/collections/{id}/tree", handler.GetCollectionTree(ms))

	req := httptest.NewRequest(http.MethodGet, "/api/collections/env-empty/tree", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d", rr.Code)
	}
	var got store.CollectionTree
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	// children must serialise as [] not null
	if got.Children == nil {
		t.Error("expected empty children array, got nil")
	}
	if len(got.Children) != 0 {
		t.Errorf("expected 0 children, got %d", len(got.Children))
	}
}

func TestGetCollectionTreeContentType(t *testing.T) {
	ms := newMockTreeStore("env-ct", &store.CollectionTree{Children: []store.TreeNode{}})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/collections/{id}/tree", handler.GetCollectionTree(ms))

	req := httptest.NewRequest(http.MethodGet, "/api/collections/env-ct/tree", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if ct := rr.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// PUT /api/collections/{id}/tree
// ──────────────────────────────────────────────────────────────────────────────

func TestPutCollectionTree(t *testing.T) {
	validBody := func() *bytes.Buffer {
		tree := store.CollectionTree{
			Children: []store.TreeNode{
				{
					ID:   "folder-1",
					Type: "folder",
					Name: "Users",
					Children: []store.TreeNode{
						{ID: "req-a", Type: "requestRef"},
					},
				},
			},
		}
		b, _ := json.Marshal(tree)
		return bytes.NewBuffer(b)
	}

	tests := []struct {
		name       string
		id         string
		body       func() *bytes.Buffer
		saveErr    error
		wantStatus int
	}{
		{
			name:       "success",
			id:         "env-001",
			body:       validBody,
			wantStatus: http.StatusNoContent,
		},
		{
			name:       "invalid JSON body",
			id:         "env-001",
			body:       func() *bytes.Buffer { return bytes.NewBufferString("not-json") },
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "missing folder name",
			id:   "env-001",
			body: func() *bytes.Buffer {
				tree := store.CollectionTree{
					Children: []store.TreeNode{
						{ID: "f1", Type: "folder"}, // name is empty
					},
				}
				b, _ := json.Marshal(tree)
				return bytes.NewBuffer(b)
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "missing node id",
			id:   "env-001",
			body: func() *bytes.Buffer {
				tree := store.CollectionTree{
					Children: []store.TreeNode{
						{Type: "folder", Name: "X"}, // id is empty
					},
				}
				b, _ := json.Marshal(tree)
				return bytes.NewBuffer(b)
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "unknown node type",
			id:   "env-001",
			body: func() *bytes.Buffer {
				tree := store.CollectionTree{
					Children: []store.TreeNode{
						{ID: "x", Type: "mystery", Name: "X"},
					},
				}
				b, _ := json.Marshal(tree)
				return bytes.NewBuffer(b)
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "requestRef at top level disallowed",
			id:   "env-001",
			body: func() *bytes.Buffer {
				tree := store.CollectionTree{
					Children: []store.TreeNode{
						{ID: "req-x", Type: "requestRef"}, // must be inside a folder
					},
				}
				b, _ := json.Marshal(tree)
				return bytes.NewBuffer(b)
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "requestRef with children disallowed",
			id:   "env-001",
			body: func() *bytes.Buffer {
				tree := store.CollectionTree{
					Children: []store.TreeNode{
						{
							ID: "folder-ok", Type: "folder", Name: "F",
							Children: []store.TreeNode{
								{
									ID:   "req-bad",
									Type: "requestRef",
									Children: []store.TreeNode{
										{ID: "child", Type: "requestRef"},
									},
								},
							},
						},
					},
				}
				b, _ := json.Marshal(tree)
				return bytes.NewBuffer(b)
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "store returns not found (bad requestRef)",
			id:         "env-001",
			body:       validBody,
			saveErr:    fmt.Errorf("req unknown: %w", store.ErrNotFound),
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "invalid id format",
			id:         "env.001", // dot not allowed
			body:       validBody,
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ms := newMockTreeStore("env-001", sampleTree())
			ms.saveErr = tc.saveErr

			mux := http.NewServeMux()
			mux.HandleFunc("PUT /api/collections/{id}/tree", handler.PutCollectionTree(ms))

			req := httptest.NewRequest(http.MethodPut, "/api/collections/"+tc.id+"/tree", tc.body())
			req.Header.Set("Content-Type", "application/json")
			rr := httptest.NewRecorder()
			mux.ServeHTTP(rr, req)

			if rr.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d  (body: %s)", rr.Code, tc.wantStatus, rr.Body.String())
			}
		})
	}
}

func TestPutCollectionTreePersists(t *testing.T) {
	ms := newMockTreeStore("env-persist", &store.CollectionTree{
		Children: []store.TreeNode{},
	})
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /api/collections/{id}/tree", handler.PutCollectionTree(ms))
	mux.HandleFunc("GET /api/collections/{id}/tree", handler.GetCollectionTree(ms))

	newTree := store.CollectionTree{
		Children: []store.TreeNode{
			{ID: "f-new", Type: "folder", Name: "New Folder"},
		},
	}
	b, _ := json.Marshal(newTree)

	// PUT the new tree
	putReq := httptest.NewRequest(http.MethodPut, "/api/collections/env-persist/tree", bytes.NewBuffer(b))
	putReq.Header.Set("Content-Type", "application/json")
	putRR := httptest.NewRecorder()
	mux.ServeHTTP(putRR, putReq)
	if putRR.Code != http.StatusNoContent {
		t.Fatalf("PUT status = %d (body: %s)", putRR.Code, putRR.Body.String())
	}

	// GET to confirm it was stored
	getReq := httptest.NewRequest(http.MethodGet, "/api/collections/env-persist/tree", nil)
	getRR := httptest.NewRecorder()
	mux.ServeHTTP(getRR, getReq)
	if getRR.Code != http.StatusOK {
		t.Fatalf("GET status = %d (body: %s)", getRR.Code, getRR.Body.String())
	}

	var got store.CollectionTree
	if err := json.Unmarshal(getRR.Body.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(got.Children) != 1 || got.Children[0].ID != "f-new" {
		t.Errorf("unexpected tree after PUT+GET: %+v", got)
	}
}

func TestPutCollectionTreeNoBody(t *testing.T) {
	ms := newMockTreeStore("env-nobody", &store.CollectionTree{Children: []store.TreeNode{}})
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /api/collections/{id}/tree", handler.PutCollectionTree(ms))

	req := httptest.NewRequest(http.MethodPut, "/api/collections/env-nobody/tree", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing body, got %d", rr.Code)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Nested folder round-trip
// ──────────────────────────────────────────────────────────────────────────────

func TestGetCollectionTreeNested(t *testing.T) {
	nested := &store.CollectionTree{
		Children: []store.TreeNode{
			{
				ID:   "parent-folder",
				Type: "folder",
				Name: "Parent",
				Children: []store.TreeNode{
					{
						ID:   "child-folder",
						Type: "folder",
						Name: "Child",
						Children: []store.TreeNode{
							{ID: "deep-req", Type: "requestRef"},
						},
					},
				},
			},
		},
	}
	ms := newMockTreeStore("env-nested", nested)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/collections/{id}/tree", handler.GetCollectionTree(ms))

	req := httptest.NewRequest(http.MethodGet, "/api/collections/env-nested/tree", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d", rr.Code)
	}
	var got store.CollectionTree
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(got.Children) != 1 {
		t.Fatalf("want 1 top-level folder, got %d", len(got.Children))
	}
	parent := got.Children[0]
	if len(parent.Children) != 1 {
		t.Fatalf("want 1 child folder, got %d", len(parent.Children))
	}
	child := parent.Children[0]
	if child.Type != "folder" || child.Name != "Child" {
		t.Errorf("unexpected child: %+v", child)
	}
	if len(child.Children) != 1 || child.Children[0].ID != "deep-req" {
		t.Errorf("expected deep-req inside child folder, got: %v", child.Children)
	}
}
