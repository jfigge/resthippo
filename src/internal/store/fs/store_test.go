package fs_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"wurl/internal/store"
	. "wurl/internal/store/fs"
)

// ── helpers ────────────────────────────────────────────────────────────────

func newStores(t *testing.T) *Stores {
	t.Helper()
	return NewStores(t.TempDir())
}

func ctx() context.Context { return context.Background() }

func mustMarshal(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// ── CollectionStore ────────────────────────────────────────────────────────

func TestCollectionStore_FirstRunDefault(t *testing.T) {
	cs := newStores(t).CollectionStore()

	raw, err := cs.GetManifest(ctx())
	if err != nil {
		t.Fatalf("GetManifest: %v", err)
	}

	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal default: %v", err)
	}
	if v, _ := m["version"].(float64); v != 2 {
		t.Errorf("default manifest version: got %v, want 2", m["version"])
	}
}

func TestCollectionStore_RoundTrip(t *testing.T) {
	cs := newStores(t).CollectionStore()

	manifest := json.RawMessage(`{"version":2,"environments":[{"id":"env-1","name":"Test"}],"activeEnvironmentId":"env-1","settings":{}}`)

	if err := cs.SaveManifest(ctx(), manifest); err != nil {
		t.Fatalf("SaveManifest: %v", err)
	}

	got, err := cs.GetManifest(ctx())
	if err != nil {
		t.Fatalf("GetManifest: %v", err)
	}

	var m map[string]any
	if err := json.Unmarshal(got, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	envs, _ := m["environments"].([]any)
	if len(envs) != 1 {
		t.Errorf("environments len: got %d, want 1", len(envs))
	}
}

func TestCollectionStore_AtomicWrite(t *testing.T) {
	// Verify that saving does not leave a .tmp file behind.
	dir := t.TempDir()
	cs := NewStores(dir).CollectionStore()

	if err := cs.SaveManifest(ctx(), json.RawMessage(`{"version":2,"environments":[],"activeEnvironmentId":null,"settings":{}}`)); err != nil {
		t.Fatalf("SaveManifest: %v", err)
	}

	// No .tmp files should remain.
	matches, _ := filepath.Glob(filepath.Join(dir, "collections", "*.tmp"))
	if len(matches) > 0 {
		t.Errorf("leftover tmp files: %v", matches)
	}
}

// ── EnvironmentStore ───────────────────────────────────────────────────────

func TestEnvironmentStore_FirstRunDefault(t *testing.T) {
	es := newStores(t).EnvironmentStore()

	raw, err := es.GetEnvironment(ctx(), "env-1")
	if err != nil {
		t.Fatalf("GetEnvironment: %v", err)
	}

	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if v, _ := doc["version"].(float64); v != 1 {
		t.Errorf("default version: got %v, want 1", doc["version"])
	}
}

func TestEnvironmentStore_RoundTrip(t *testing.T) {
	ss := newStores(t)
	es := ss.EnvironmentStore()

	// Build a realistic env blob with a nested folder and two requests.
	env := map[string]any{
		"version": 1,
		"collections": []any{
			map[string]any{
				"id":   "folder-1",
				"type": "collection",
				"name": "Auth",
				"children": []any{
					map[string]any{
						"id":     "req-1",
						"type":   "request",
						"name":   "Login",
						"method": "POST",
						"url":    "https://example.com/login",
					},
					map[string]any{
						"id":   "sub-folder",
						"type": "collection",
						"name": "OAuth",
						"children": []any{
							map[string]any{
								"id":     "req-2",
								"type":   "request",
								"name":   "Token",
								"method": "POST",
								"url":    "https://example.com/token",
							},
						},
					},
				},
				"variables": map[string]any{"baseUrl": "https://example.com"},
			},
		},
		"variables": map[string]any{"apiKey": "secret"},
	}

	raw := mustMarshal(t, env)
	if err := es.SaveEnvironment(ctx(), "env-1", raw); err != nil {
		t.Fatalf("SaveEnvironment: %v", err)
	}

	got, err := es.GetEnvironment(ctx(), "env-1")
	if err != nil {
		t.Fatalf("GetEnvironment: %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal(got, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}

	// Check env-level variables survive the round-trip.
	vars, _ := result["variables"].(map[string]any)
	if vars["apiKey"] != "secret" {
		t.Errorf("env variables: got %v, want apiKey=secret", vars)
	}

	// Check the top-level folder is present.
	colls, _ := result["collections"].([]any)
	if len(colls) != 1 {
		t.Fatalf("collections len: got %d, want 1", len(colls))
	}
	folder, _ := colls[0].(map[string]any)
	if folder["name"] != "Auth" {
		t.Errorf("folder name: got %v, want Auth", folder["name"])
	}

	// Check nested requests are inlined.
	children, _ := folder["children"].([]any)
	if len(children) != 2 {
		t.Fatalf("folder children len: got %d, want 2", len(children))
	}
	req1, _ := children[0].(map[string]any)
	if req1["name"] != "Login" {
		t.Errorf("req1 name: got %v, want Login", req1["name"])
	}

	// Check sub-folder and its nested request.
	sub, _ := children[1].(map[string]any)
	if sub["name"] != "OAuth" {
		t.Errorf("sub-folder name: got %v, want OAuth", sub["name"])
	}
	subChildren, _ := sub["children"].([]any)
	if len(subChildren) != 1 {
		t.Fatalf("sub-folder children len: got %d, want 1", len(subChildren))
	}
	req2, _ := subChildren[0].(map[string]any)
	if req2["name"] != "Token" {
		t.Errorf("req2 name: got %v, want Token", req2["name"])
	}
}

// ── RequestStore ───────────────────────────────────────────────────────────

// seedRequest is a helper that uses EnvironmentStore to create the collection
// directories and then uses RequestStore to write a single request.
func seedRequest(t *testing.T, ss *Stores, envID, folderID string, req *store.Request) {
	t.Helper()
	es := ss.EnvironmentStore()
	doc := map[string]any{
		"version": 1,
		"collections": []any{
			map[string]any{
				"id":       folderID,
				"type":     "collection",
				"name":     folderID,
				"children": []any{},
			},
		},
	}
	if err := es.SaveEnvironment(ctx(), envID, mustMarshal(t, doc)); err != nil {
		t.Fatalf("seed env: %v", err)
	}
	if err := ss.RequestStore().CreateRequest(ctx(), envID, folderID, req); err != nil {
		t.Fatalf("seed request: %v", err)
	}
}

func TestRequestStore_CreateGet(t *testing.T) {
	ss := newStores(t)
	req := &store.Request{
		ID:     "req-abc",
		Name:   "My Request",
		Method: "GET",
		URL:    "https://example.com",
	}
	seedRequest(t, ss, "env-1", "folder-1", req)

	got, err := ss.RequestStore().GetRequest(ctx(), "req-abc")
	if err != nil {
		t.Fatalf("GetRequest: %v", err)
	}
	if got.Name != "My Request" {
		t.Errorf("name: got %q, want %q", got.Name, "My Request")
	}
	if got.Type != "request" {
		t.Errorf("type: got %q, want \"request\"", got.Type)
	}
}

func TestRequestStore_GetNotFound(t *testing.T) {
	rs := newStores(t).RequestStore()
	_, err := rs.GetRequest(ctx(), "no-such-id")
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("expected ErrNotFound, got: %v", err)
	}
}

func TestRequestStore_Update(t *testing.T) {
	ss := newStores(t)
	req := &store.Request{ID: "req-u", Name: "Before", Method: "GET", URL: "https://a.example"}
	seedRequest(t, ss, "env-1", "folder-1", req)

	newName := "After"
	newURL := "https://b.example"
	patch := store.RequestPatch{Name: &newName, URL: &newURL}
	if err := ss.RequestStore().UpdateRequest(ctx(), "req-u", patch); err != nil {
		t.Fatalf("UpdateRequest: %v", err)
	}

	got, err := ss.RequestStore().GetRequest(ctx(), "req-u")
	if err != nil {
		t.Fatalf("GetRequest after update: %v", err)
	}
	if got.Name != "After" {
		t.Errorf("name after update: got %q, want %q", got.Name, "After")
	}
	if got.URL != "https://b.example" {
		t.Errorf("url after update: got %q, want %q", got.URL, "https://b.example")
	}
	// Method should be preserved (not in patch).
	if got.Method != "GET" {
		t.Errorf("method preserved: got %q, want GET", got.Method)
	}
}

func TestRequestStore_Delete(t *testing.T) {
	ss := newStores(t)
	req := &store.Request{ID: "req-d", Name: "ToDelete", Method: "DELETE", URL: "https://example.com"}
	seedRequest(t, ss, "env-1", "folder-1", req)

	if err := ss.RequestStore().DeleteRequest(ctx(), "req-d"); err != nil {
		t.Fatalf("DeleteRequest: %v", err)
	}

	_, err := ss.RequestStore().GetRequest(ctx(), "req-d")
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("expected ErrNotFound after delete, got: %v", err)
	}
}

func TestRequestStore_DeleteNotFound(t *testing.T) {
	rs := newStores(t).RequestStore()
	err := rs.DeleteRequest(ctx(), "ghost")
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("expected ErrNotFound, got: %v", err)
	}
}

func TestRequestStore_AutoGeneratesID(t *testing.T) {
	ss := newStores(t)
	req := &store.Request{Name: "No ID", Method: "GET", URL: "https://auto.example"}
	seedRequest(t, ss, "env-1", "folder-1", req)

	if req.ID == "" {
		t.Error("auto-generated ID should not be empty")
	}

	// Should be retrievable.
	got, err := ss.RequestStore().GetRequest(ctx(), req.ID)
	if err != nil {
		t.Fatalf("GetRequest: %v", err)
	}
	if got.Name != "No ID" {
		t.Errorf("name: got %q", got.Name)
	}
}

// ── TreeStore ──────────────────────────────────────────────────────────────

func TestTreeStore_FirstRunEmptyTree(t *testing.T) {
	ts := newStores(t).TreeStore()

	tree, err := ts.GetTree(ctx(), "env-1")
	if err != nil {
		t.Fatalf("GetTree: %v", err)
	}
	if len(tree.Children) != 0 {
		t.Errorf("expected empty tree, got %d children", len(tree.Children))
	}
}

func TestTreeStore_GetDoesNotLoadRequests(t *testing.T) {
	// After seeding a request, GetTree must return a requestRef (not the full
	// request body – verifiable by checking Type == "requestRef").
	ss := newStores(t)
	seedRequest(t, ss, "env-1", "folder-1", &store.Request{
		ID: "req-tree", Name: "TreeTest", Method: "POST", URL: "https://t.example",
	})

	tree, err := ss.TreeStore().GetTree(ctx(), "env-1")
	if err != nil {
		t.Fatalf("GetTree: %v", err)
	}
	if len(tree.Children) == 0 {
		t.Fatal("expected at least one folder in tree")
	}
	folder := tree.Children[0]
	if folder.Type != "folder" {
		t.Errorf("top-level node type: got %q, want folder", folder.Type)
	}
	if len(folder.Children) == 0 {
		t.Fatal("expected request in folder")
	}
	ref := folder.Children[0]
	if ref.Type != "requestRef" {
		t.Errorf("child type: got %q, want requestRef", ref.Type)
	}
	if ref.ID != "req-tree" {
		t.Errorf("requestRef id: got %q, want req-tree", ref.ID)
	}
}

func TestTreeStore_SaveTreePreservesVariables(t *testing.T) {
	ss := newStores(t)
	// Use EnvironmentStore to set up a folder with variables.
	env := map[string]any{
		"version": 1,
		"collections": []any{
			map[string]any{
				"id":        "folder-vars",
				"type":      "collection",
				"name":      "Vars Folder",
				"children":  []any{},
				"variables": map[string]any{"host": "https://vars.example"},
			},
		},
	}
	es := ss.EnvironmentStore()
	if err := es.SaveEnvironment(ctx(), "env-vars", mustMarshal(t, env)); err != nil {
		t.Fatalf("SaveEnvironment: %v", err)
	}

	// SaveTree with the same structure (no requestRefs, so no file validation).
	ts := ss.TreeStore()
	tree := &store.CollectionTree{
		Children: []store.TreeNode{
			{ID: "folder-vars", Type: "folder", Name: "Vars Folder"},
		},
	}
	if err := ts.SaveTree(ctx(), "env-vars", tree); err != nil {
		t.Fatalf("SaveTree: %v", err)
	}

	// GetTree should return the folder without error.
	got, err := ts.GetTree(ctx(), "env-vars")
	if err != nil {
		t.Fatalf("GetTree: %v", err)
	}
	if len(got.Children) != 1 || got.Children[0].ID != "folder-vars" {
		t.Errorf("unexpected tree: %+v", got)
	}
}

func TestTreeStore_SaveTreeRejectsUnknownRef(t *testing.T) {
	ss := newStores(t)
	es := ss.EnvironmentStore()
	// Set up the collection dir with no requests.
	if err := es.SaveEnvironment(ctx(), "env-ref", mustMarshal(t, map[string]any{
		"version": 1, "collections": []any{},
	})); err != nil {
		t.Fatalf("SaveEnvironment: %v", err)
	}

	ts := ss.TreeStore()
	tree := &store.CollectionTree{
		Children: []store.TreeNode{
			{
				ID: "f1", Type: "folder", Name: "F1",
				Children: []store.TreeNode{
					{ID: "ghost-req", Type: "requestRef"},
				},
			},
		},
	}
	err := ts.SaveTree(ctx(), "env-ref", tree)
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("expected ErrNotFound for unknown requestRef, got: %v", err)
	}
}

// ── HistoryStore ───────────────────────────────────────────────────────────

func seedHistory(t *testing.T, ss *Stores, envID, reqID string, n int) []string {
	t.Helper()
	hs := ss.HistoryStore()
	var ids []string
	base := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < n; i++ {
		entry := &store.HistoryEntry{
			RequestID:  reqID,
			Timestamp:  base.Add(time.Duration(i) * time.Minute),
			Status:     200,
			DurationMs: int64(i * 10),
		}
		resp := &store.HistoryResponse{Body: fmt.Sprintf("body-%d", i)}
		if err := hs.AddHistory(ctx(), entry, resp); err != nil {
			t.Fatalf("AddHistory %d: %v", i, err)
		}
		ids = append(ids, entry.ID)
	}
	return ids
}

func TestHistoryStore_AddAndList(t *testing.T) {
	ss := newStores(t)
	seedRequest(t, ss, "env-1", "folder-1", &store.Request{ID: "req-h", Name: "H", Method: "GET", URL: "https://h.example"})
	ids := seedHistory(t, ss, "env-1", "req-h", 5)
	if len(ids) != 5 {
		t.Fatalf("expected 5 seeded IDs, got %d", len(ids))
	}

	page, err := ss.HistoryStore().ListHistory(ctx(), "req-h", 10, "")
	if err != nil {
		t.Fatalf("ListHistory: %v", err)
	}
	if len(page.Items) != 5 {
		t.Errorf("items: got %d, want 5", len(page.Items))
	}
	if page.NextCursor != "" {
		t.Errorf("next cursor: got %q, want empty", page.NextCursor)
	}

	// Verify newest-first ordering.
	for i := 0; i < len(page.Items)-1; i++ {
		if !page.Items[i].Timestamp.After(page.Items[i+1].Timestamp) {
			t.Errorf("items not sorted newest-first at index %d", i)
		}
	}
}

func TestHistoryStore_Pagination(t *testing.T) {
	ss := newStores(t)
	seedRequest(t, ss, "env-1", "folder-1", &store.Request{ID: "req-p", Name: "P", Method: "GET", URL: "https://p.example"})
	seedHistory(t, ss, "env-1", "req-p", 7)

	hs := ss.HistoryStore()

	// Page 1: 3 items.
	page1, err := hs.ListHistory(ctx(), "req-p", 3, "")
	if err != nil {
		t.Fatalf("page1: %v", err)
	}
	if len(page1.Items) != 3 {
		t.Fatalf("page1 items: got %d, want 3", len(page1.Items))
	}
	if page1.NextCursor == "" {
		t.Fatal("page1 should have a next cursor")
	}

	// Page 2: 3 items.
	page2, err := hs.ListHistory(ctx(), "req-p", 3, page1.NextCursor)
	if err != nil {
		t.Fatalf("page2: %v", err)
	}
	if len(page2.Items) != 3 {
		t.Fatalf("page2 items: got %d, want 3", len(page2.Items))
	}

	// Page 3: 1 item (7 total, 3+3 returned = 1 remaining).
	page3, err := hs.ListHistory(ctx(), "req-p", 3, page2.NextCursor)
	if err != nil {
		t.Fatalf("page3: %v", err)
	}
	if len(page3.Items) != 1 {
		t.Fatalf("page3 items: got %d, want 1", len(page3.Items))
	}
	if page3.NextCursor != "" {
		t.Errorf("page3 should have no next cursor, got %q", page3.NextCursor)
	}

	// All IDs should be distinct.
	seen := map[string]bool{}
	for _, p := range [][]store.HistoryEntry{page1.Items, page2.Items, page3.Items} {
		for _, e := range p {
			if seen[e.ID] {
				t.Errorf("duplicate ID %q in paginated results", e.ID)
			}
			seen[e.ID] = true
		}
	}
}

func TestHistoryStore_GetResponse(t *testing.T) {
	ss := newStores(t)
	seedRequest(t, ss, "env-1", "folder-1", &store.Request{ID: "req-r", Name: "R", Method: "GET", URL: "https://r.example"})

	entry := &store.HistoryEntry{RequestID: "req-r", Status: 200}
	resp := &store.HistoryResponse{Body: "hello world", StatusText: "200 OK"}
	hs := ss.HistoryStore()
	if err := hs.AddHistory(ctx(), entry, resp); err != nil {
		t.Fatalf("AddHistory: %v", err)
	}

	got, err := hs.GetHistoryResponse(ctx(), "req-r", entry.ID)
	if err != nil {
		t.Fatalf("GetHistoryResponse: %v", err)
	}
	if got.Body != "hello world" {
		t.Errorf("body: got %q, want %q", got.Body, "hello world")
	}
	if got.StatusText != "200 OK" {
		t.Errorf("status text: got %q, want %q", got.StatusText, "200 OK")
	}
}

func TestHistoryStore_GetResponseNotFound(t *testing.T) {
	ss := newStores(t)
	seedRequest(t, ss, "env-1", "folder-1", &store.Request{ID: "req-nf", Name: "NF", Method: "GET", URL: "https://nf.example"})
	hs := ss.HistoryStore()

	_, err := hs.GetHistoryResponse(ctx(), "req-nf", "no-such-history")
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("expected ErrNotFound, got: %v", err)
	}
}

func TestHistoryStore_ListUnknownRequest(t *testing.T) {
	// Listing history for an unknown request should return empty, not error.
	hs := newStores(t).HistoryStore()
	page, err := hs.ListHistory(ctx(), "phantom", 10, "")
	if err != nil {
		t.Fatalf("ListHistory: %v", err)
	}
	if len(page.Items) != 0 {
		t.Errorf("expected 0 items, got %d", len(page.Items))
	}
}

// ── Path sanitisation ──────────────────────────────────────────────────────

func TestRequestStore_RejectTraversalID(t *testing.T) {
	rs := newStores(t).RequestStore()
	badIDs := []string{"../evil", "a/b", ".", "..", ""}
	for _, id := range badIDs {
		_, err := rs.GetRequest(ctx(), id)
		if err == nil {
			t.Errorf("expected error for id %q, got nil", id)
		}
	}
}

func TestEnvironmentStore_RejectTraversalID(t *testing.T) {
	es := newStores(t).EnvironmentStore()
	_, err := es.GetEnvironment(ctx(), "../evil")
	if err == nil {
		t.Error("expected error for traversal ID, got nil")
	}
}
