// Package fs provides filesystem-backed implementations of the store interfaces.
// See io.go for the full directory-layout documentation.
package fs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"wurl/internal/store"
)

// ──────────────────────────────────────────────────────────────────────────────
// CollectionStore
// ──────────────────────────────────────────────────────────────────────────────

// CollectionStore implements store.CollectionStore.
//
// The manifest is stored at collections/index.json. It preserves the existing
// JSON shape (version, environments[], activeEnvironmentId, settings) so the
// HTTP handler and frontend require no changes.
type CollectionStore struct {
	p *paths
}

// GetManifest returns the manifest from collections/index.json.
// Returns a valid empty v2 manifest on first run.
func (s *CollectionStore) GetManifest(_ context.Context) (json.RawMessage, error) {
	if err := ensureDir(s.p.collectionsDir()); err != nil {
		return nil, fmt.Errorf("collections: ensure dir: %w", err)
	}
	var raw json.RawMessage
	err := readJSON(s.p.manifestPath(), &raw)
	if err != nil {
		if os.IsNotExist(err) {
			return json.RawMessage(`{"version":2,"environments":[],"activeEnvironmentId":null,"settings":{}}`), nil
		}
		return nil, fmt.Errorf("collections: read manifest: %w", err)
	}
	return raw, nil
}

// SaveManifest atomically writes the manifest to collections/index.json.
func (s *CollectionStore) SaveManifest(_ context.Context, data json.RawMessage) error {
	if err := ensureDir(s.p.collectionsDir()); err != nil {
		return fmt.Errorf("collections: ensure dir: %w", err)
	}
	// Re-marshal to normalise whitespace.
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("collections: marshal manifest: %w", err)
	}
	if err := atomicWrite(s.p.manifestPath(), out); err != nil {
		return fmt.Errorf("collections: save manifest: %w", err)
	}
	return nil
}

// ──────────────────────────────────────────────────────────────────────────────
// EnvironmentStore
// ──────────────────────────────────────────────────────────────────────────────

// EnvironmentStore implements store.EnvironmentStore.
//
// It preserves the old monolithic environment blob shape so the existing HTTP
// handler and frontend remain unchanged. Internally, it assembles the blob from
// the new per-file layout on read and decomposes it into separate files on write.
//
// Assembly (GetEnvironment):
//  1. Read collections/<id>/metadata.json   → env-level variables
//  2. Read collections/<id>/tree.json       → folder/requestRef structure
//  3. For each requestRef, load             → collections/<id>/requests/<reqID>.json
//  4. Inline request data into the tree and return the old JSON shape.
//
// Decomposition (SaveEnvironment):
//  1. Parse the incoming blob.
//  2. Write metadata.json with env-level variables.
//  3. Walk the blob's collection/request tree; extract each request.
//  4. Write each request to collections/<id>/requests/<reqID>.json.
//  5. Write tree.json (folder structure + requestRef IDs, no request data).
//  6. Invalidate the shared resolver cache.
type EnvironmentStore struct {
	p *paths
	r *resolver
}

// GetEnvironment assembles and returns the environment blob for id.
// Returns a minimal default on first run.
func (s *EnvironmentStore) GetEnvironment(_ context.Context, id string) (json.RawMessage, error) {
	if err := validateID(id, "environment"); err != nil {
		return nil, err
	}

	// Read metadata.
	var meta collectionMetadata
	if err := readJSON(s.p.metadataPath(id), &meta); err != nil {
		if os.IsNotExist(err) {
			return json.RawMessage(`{"version":1,"collections":[]}`), nil
		}
		return nil, fmt.Errorf("environment %s: read metadata: %w", id, err)
	}

	// Read tree.
	var itree internalTree
	if err := readJSON(s.p.treePath(id), &itree); err != nil {
		if os.IsNotExist(err) {
			// metadata exists but no tree → return bare doc
			doc := legacyEnvDoc{Version: 1, Variables: meta.Variables}
			return json.Marshal(doc)
		}
		return nil, fmt.Errorf("environment %s: read tree: %w", id, err)
	}

	// Build legacy collections by loading individual request files.
	colls, err := s.buildLegacyCollections(id, itree.Children)
	if err != nil {
		return nil, fmt.Errorf("environment %s: assemble: %w", id, err)
	}

	doc := legacyEnvDoc{
		Version:     1,
		Collections: colls,
		Variables:   meta.Variables,
	}
	return json.Marshal(doc)
}

// buildLegacyCollections converts top-level internalTreeNodes (folders) to
// legacyCollDocs with embedded request data.
func (s *EnvironmentStore) buildLegacyCollections(collID string, nodes []internalTreeNode) ([]legacyCollDoc, error) {
	colls := make([]legacyCollDoc, 0, len(nodes))
	for _, node := range nodes {
		if node.Type != "folder" {
			continue // requestRefs at top level are ignored in old format
		}
		children, err := s.buildLegacyChildren(collID, node.Children)
		if err != nil {
			return nil, err
		}
		colls = append(colls, legacyCollDoc{
			ID:        node.ID,
			Type:      "collection",
			Name:      node.Name,
			Children:  children,
			Variables: node.Variables,
		})
	}
	return colls, nil
}

// buildLegacyChildren recursively builds the children slice of a legacyCollDoc.
func (s *EnvironmentStore) buildLegacyChildren(collID string, nodes []internalTreeNode) ([]json.RawMessage, error) {
	children := make([]json.RawMessage, 0, len(nodes))
	for _, node := range nodes {
		switch node.Type {
		case "requestRef":
			var raw json.RawMessage
			if err := readJSON(s.p.requestPath(collID, node.ID), &raw); err != nil {
				if os.IsNotExist(err) {
					// Request file missing – skip rather than corrupting the blob.
					continue
				}
				return nil, fmt.Errorf("load request %s: %w", node.ID, err)
			}
			children = append(children, raw)

		case "folder":
			sub, err := s.buildLegacyChildren(collID, node.Children)
			if err != nil {
				return nil, err
			}
			coll := legacyCollDoc{
				ID:        node.ID,
				Type:      "collection",
				Name:      node.Name,
				Children:  sub,
				Variables: node.Variables,
			}
			raw, err := json.Marshal(coll)
			if err != nil {
				return nil, fmt.Errorf("marshal folder %s: %w", node.ID, err)
			}
			children = append(children, raw)
		}
	}
	return children, nil
}

// SaveEnvironment decomposes the environment blob and writes individual files.
func (s *EnvironmentStore) SaveEnvironment(_ context.Context, id string, data json.RawMessage) error {
	if err := validateID(id, "environment"); err != nil {
		return err
	}

	var doc legacyEnvDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("environment %s: parse: %w", id, err)
	}

	// Ensure directories exist.
	if err := ensureDir(s.p.collectionDir(id)); err != nil {
		return err
	}
	if err := ensureDir(s.p.requestsDir(id)); err != nil {
		return err
	}

	// Write metadata.json.
	meta := collectionMetadata{ID: id, Variables: doc.Variables}
	if err := writeJSON(s.p.metadataPath(id), meta); err != nil {
		return fmt.Errorf("environment %s: write metadata: %w", id, err)
	}

	// Decompose collections → tree nodes + request files.
	treeNodes, reqFiles, err := s.decomposeCollections(doc.Collections)
	if err != nil {
		return fmt.Errorf("environment %s: decompose: %w", id, err)
	}

	// Write tree.json.
	itree := internalTree{Children: treeNodes}
	if err := writeJSON(s.p.treePath(id), itree); err != nil {
		return fmt.Errorf("environment %s: write tree: %w", id, err)
	}

	// Write individual request files.
	for reqID, reqData := range reqFiles {
		if err := validateID(reqID, "request"); err != nil {
			continue // skip malformed IDs
		}
		out, err := json.MarshalIndent(reqData, "", "  ")
		if err != nil {
			return fmt.Errorf("environment %s: marshal request %s: %w", id, reqID, err)
		}
		if err := atomicWrite(s.p.requestPath(id, reqID), out); err != nil {
			return err
		}
	}

	// Invalidate resolver so new request→collection mappings are found.
	s.r.invalidate()
	return nil
}

// decomposeCollections converts a legacyCollDoc slice into internalTreeNodes
// and extracts all request raw JSON keyed by request ID.
func (s *EnvironmentStore) decomposeCollections(colls []legacyCollDoc) ([]internalTreeNode, map[string]json.RawMessage, error) {
	nodes := make([]internalTreeNode, 0, len(colls))
	reqFiles := make(map[string]json.RawMessage)
	for _, coll := range colls {
		node, err := s.decomposeCollDoc(coll, reqFiles)
		if err != nil {
			return nil, nil, err
		}
		nodes = append(nodes, node)
	}
	return nodes, reqFiles, nil
}

func (s *EnvironmentStore) decomposeCollDoc(coll legacyCollDoc, reqFiles map[string]json.RawMessage) (internalTreeNode, error) {
	node := internalTreeNode{
		ID:        coll.ID,
		Type:      "folder",
		Name:      coll.Name,
		Variables: coll.Variables,
	}
	for _, childRaw := range coll.Children {
		var peek legacyNodePeek
		if err := json.Unmarshal(childRaw, &peek); err != nil {
			continue
		}
		switch peek.Type {
		case "request":
			node.Children = append(node.Children, internalTreeNode{
				ID:   peek.ID,
				Type: "requestRef",
			})
			reqFiles[peek.ID] = childRaw

		case "collection":
			var nested legacyCollDoc
			if err := json.Unmarshal(childRaw, &nested); err != nil {
				continue
			}
			nestedNode, err := s.decomposeCollDoc(nested, reqFiles)
			if err != nil {
				return internalTreeNode{}, err
			}
			node.Children = append(node.Children, nestedNode)
		}
	}
	return node, nil
}

// Ensure interface compliance at compile time.
var (
	_ store.CollectionStore  = (*CollectionStore)(nil)
	_ store.EnvironmentStore = (*EnvironmentStore)(nil)
)
