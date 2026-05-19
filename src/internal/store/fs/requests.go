package fs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"wurl/internal/store"
)

// ──────────────────────────────────────────────────────────────────────────────
// RequestStore
// ──────────────────────────────────────────────────────────────────────────────

// RequestStore implements store.RequestStore using the new per-file layout.
//
// Each request is stored as collections/<collID>/requests/<reqID>.json.
// The resolver cache is used to locate a request's collection by ID without
// scanning all collection directories on every call.
//
// Tree updates (adding/removing requestRefs) are kept in sync with the request
// files so that TreeStore.GetTree always reflects the current request set.
type RequestStore struct {
	p *paths
	r *resolver
}

// GetRequest reads and returns the request identified by id.
func (s *RequestStore) GetRequest(_ context.Context, id string) (*store.Request, error) {
	if err := validateID(id, "request"); err != nil {
		return nil, err
	}
	collID, err := s.r.resolve(id)
	if err != nil {
		return nil, err
	}
	path := s.p.requestPath(collID, id)
	var req store.Request
	if err := readJSON(path, &req); err != nil {
		if os.IsNotExist(err) {
			return nil, store.ErrNotFound
		}
		return nil, fmt.Errorf("request %s: read: %w", id, err)
	}
	return &req, nil
}

// CreateRequest writes a new request file under the given collection
// and appends a requestRef to the target folder in tree.json.
func (s *RequestStore) CreateRequest(_ context.Context, environmentID, collectionID string, req *store.Request) error {
	if err := validateID(environmentID, "environment"); err != nil {
		return err
	}
	if err := validateID(collectionID, "collection"); err != nil {
		return err
	}
	if req.ID == "" {
		req.ID = newUUID()
	}
	req.Type = "request"

	// Ensure requests directory exists.
	if err := ensureDir(s.p.requestsDir(environmentID)); err != nil {
		return err
	}

	// Write the request file.
	if err := writeJSON(s.p.requestPath(environmentID, req.ID), req); err != nil {
		return fmt.Errorf("request %s: write: %w", req.ID, err)
	}

	// Add requestRef to the tree under collectionID.
	if err := s.appendToTree(environmentID, collectionID, req.ID); err != nil {
		// Best-effort rollback: remove the request file.
		_ = os.Remove(s.p.requestPath(environmentID, req.ID))
		return err
	}

	// Update resolver cache.
	s.r.set(req.ID, environmentID)
	return nil
}

// appendToTree adds a requestRef for reqID to the folder identified by
// collectionID in the tree, then atomically saves the updated tree.
func (s *RequestStore) appendToTree(envID, collectionID, reqID string) error {
	var itree internalTree
	if err := readJSON(s.p.treePath(envID), &itree); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("append tree: read: %w", err)
	}

	ref := internalTreeNode{ID: reqID, Type: "requestRef"}
	inserted := insertRefInTree(itree.Children, collectionID, ref)
	if !inserted {
		// collectionID not found in tree – add as top-level folder.
		itree.Children = append(itree.Children, internalTreeNode{
			ID:       collectionID,
			Type:     "folder",
			Name:     collectionID,
			Children: []internalTreeNode{ref},
		})
	}

	if err := ensureDir(s.p.collectionDir(envID)); err != nil {
		return err
	}
	return writeJSON(s.p.treePath(envID), itree)
}

// insertRefInTree recursively searches nodes for the folder with id == targetID
// and appends ref to its Children. Returns true if found.
func insertRefInTree(nodes []internalTreeNode, targetID string, ref internalTreeNode) bool {
	for i := range nodes {
		if nodes[i].Type == "folder" && nodes[i].ID == targetID {
			nodes[i].Children = append(nodes[i].Children, ref)
			return true
		}
		if insertRefInTree(nodes[i].Children, targetID, ref) {
			return true
		}
	}
	return false
}

// UpdateRequest applies a partial patch to the stored request file.
// Unknown fields in the JSON are preserved via map[string]interface{}.
func (s *RequestStore) UpdateRequest(_ context.Context, id string, patch store.RequestPatch) error {
	if err := validateID(id, "request"); err != nil {
		return err
	}
	collID, err := s.r.resolve(id)
	if err != nil {
		return err
	}
	path := s.p.requestPath(collID, id)

	// Read as raw map to preserve unknown fields.
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return store.ErrNotFound
		}
		return fmt.Errorf("request %s: read for patch: %w", id, err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		return fmt.Errorf("request %s: parse for patch: %w", id, err)
	}

	applyRequestPatch(m, patch)

	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return fmt.Errorf("request %s: marshal after patch: %w", id, err)
	}
	return atomicWrite(path, out)
}

// applyRequestPatch merges non-nil patch fields into m.
func applyRequestPatch(m map[string]interface{}, p store.RequestPatch) {
	if p.Name != nil {
		m["name"] = *p.Name
	}
	if p.Method != nil {
		m["method"] = *p.Method
	}
	if p.URL != nil {
		m["url"] = *p.URL
	}
	if p.BodyType != nil {
		m["bodyType"] = *p.BodyType
	}
	if p.BodyText != nil {
		m["bodyText"] = *p.BodyText
	}
	if p.BodyFilePath != nil {
		m["bodyFilePath"] = *p.BodyFilePath
	}
	if p.BodyFormRows != nil {
		m["bodyFormRows"] = p.BodyFormRows
	}
	if p.Params != nil {
		m["params"] = p.Params
	}
	if p.Headers != nil {
		m["headers"] = p.Headers
	}
	if p.AuthEnabled != nil {
		m["authEnabled"] = *p.AuthEnabled
	}
	if p.AuthType != nil {
		m["authType"] = *p.AuthType
	}
	if p.AuthBasic != nil {
		m["authBasic"] = p.AuthBasic
	}
	if p.AuthBearer != nil {
		m["authBearer"] = p.AuthBearer
	}
	if p.AuthOAuth2 != nil {
		m["authOAuth2"] = p.AuthOAuth2
	}
	if p.AuthAwsIam != nil {
		m["authAwsIam"] = p.AuthAwsIam
	}
	if p.PreRequestScript != nil {
		m["preRequestScript"] = *p.PreRequestScript
	}
	if p.AfterResponseScript != nil {
		m["afterResponseScript"] = *p.AfterResponseScript
	}
	if p.Notes != nil {
		m["notes"] = *p.Notes
	}
}

// DeleteRequest removes the request file and the corresponding requestRef
// from the tree.
func (s *RequestStore) DeleteRequest(_ context.Context, id string) error {
	if err := validateID(id, "request"); err != nil {
		return err
	}
	collID, err := s.r.resolve(id)
	if err != nil {
		return err
	}

	// Remove the request file.
	path := s.p.requestPath(collID, id)
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return store.ErrNotFound
		}
		return fmt.Errorf("request %s: delete: %w", id, err)
	}

	// Remove the requestRef from the tree (best-effort; file is already gone).
	_ = s.removeFromTree(collID, id)

	// Update resolver cache.
	s.r.remove(id)
	return nil
}

// removeFromTree removes the requestRef for reqID from the collection's tree.
func (s *RequestStore) removeFromTree(collID, reqID string) error {
	var itree internalTree
	if err := readJSON(s.p.treePath(collID), &itree); err != nil {
		return err
	}
	itree.Children = removeRefFromTree(itree.Children, reqID)
	return writeJSON(s.p.treePath(collID), itree)
}

// removeRefFromTree recursively removes the requestRef with id == reqID.
func removeRefFromTree(nodes []internalTreeNode, reqID string) []internalTreeNode {
	result := make([]internalTreeNode, 0, len(nodes))
	for _, n := range nodes {
		if n.Type == "requestRef" && n.ID == reqID {
			continue // drop it
		}
		if n.Type == "folder" {
			n.Children = removeRefFromTree(n.Children, reqID)
		}
		result = append(result, n)
	}
	return result
}

var _ store.RequestStore = (*RequestStore)(nil)
