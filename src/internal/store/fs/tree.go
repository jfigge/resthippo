package fs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"wurl/internal/store"
)

// ──────────────────────────────────────────────────────────────────────────────
// TreeStore
// ──────────────────────────────────────────────────────────────────────────────

// TreeStore implements store.TreeStore using the new layout.
//
// The navigation tree is stored as collections/<collID>/tree.json in the
// internalTree format (which extends store.CollectionTree with per-folder
// Variables). Reads never touch request files or history, keeping tree
// loads fast regardless of how many or how large the stored requests are.
//
// SaveTree verifies that every requestRef in the new tree has a corresponding
// request file before committing the write, preventing dangling references.
type TreeStore struct {
	p *paths
	r *resolver
}

// GetTree reads tree.json and returns a lightweight CollectionTree.
// Returns an empty tree on first run (no file yet), never an error for a
// missing file. Tree loads never read request files.
func (s *TreeStore) GetTree(_ context.Context, envID string) (*store.CollectionTree, error) {
	if err := validateID(envID, "environment"); err != nil {
		return nil, err
	}

	var itree internalTree
	if err := readJSON(s.p.treePath(envID), &itree); err != nil {
		if os.IsNotExist(err) {
			return &store.CollectionTree{Children: []store.TreeNode{}}, nil
		}
		return nil, fmt.Errorf("tree %s: read: %w", envID, err)
	}

	children := make([]store.TreeNode, 0, len(itree.Children))
	for _, n := range itree.Children {
		children = append(children, internalToStore(n))
	}
	return &store.CollectionTree{Children: children}, nil
}

// SaveTree replaces the navigation tree for the given environment.
//
// Guarantees:
//   - Every requestRef must have a corresponding request file; missing refs
//     are rejected with a wrapped ErrNotFound.
//   - Folder variables from the existing tree are carried over for any folder
//     whose ID appears in both the old and the new tree.
//   - The write is atomic (tmp + rename).
func (s *TreeStore) SaveTree(_ context.Context, envID string, tree *store.CollectionTree) error {
	if err := validateID(envID, "environment"); err != nil {
		return err
	}

	// Load existing tree to preserve per-folder Variables.
	varsIdx := make(map[string]json.RawMessage)
	var existing internalTree
	if err := readJSON(s.p.treePath(envID), &existing); err == nil {
		buildVarsIndex(existing.Children, varsIdx)
	}

	// Validate all requestRef IDs against the requests/ directory.
	if err := s.validateRefs(envID, tree.Children); err != nil {
		return err
	}

	// Convert to on-disk format, restoring saved folder variables.
	inNodes := make([]internalTreeNode, 0, len(tree.Children))
	for _, n := range tree.Children {
		inNodes = append(inNodes, storeToInternal(n, varsIdx))
	}
	itree := internalTree{Children: inNodes}

	if err := ensureDir(s.p.collectionDir(envID)); err != nil {
		return err
	}
	return writeJSON(s.p.treePath(envID), itree)
}

// validateRefs checks that every requestRef in nodes has a corresponding
// request file. Returns a wrapped ErrNotFound for the first missing ref.
func (s *TreeStore) validateRefs(envID string, nodes []store.TreeNode) error {
	for _, n := range nodes {
		switch n.Type {
		case "requestRef":
			if _, err := os.Stat(s.p.requestPath(envID, n.ID)); os.IsNotExist(err) {
				return fmt.Errorf("requestRef %q: no request file: %w", n.ID, store.ErrNotFound)
			}
		case "folder":
			if err := s.validateRefs(envID, n.Children); err != nil {
				return err
			}
		}
	}
	return nil
}

var _ store.TreeStore = (*TreeStore)(nil)
