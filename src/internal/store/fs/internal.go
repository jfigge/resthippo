package fs

import (
	"encoding/json"

	"wurl/internal/store"
)

// ── On-disk tree format ────────────────────────────────────────────────────
//
// tree.json uses internalTreeNode which extends store.TreeNode with a
// Variables field carrying per-folder variable maps. store.TreeNode doesn't
// expose Variables so they are stripped when converting to the public type.

type internalTreeNode struct {
	ID        string             `json:"id"`
	Type      string             `json:"type"`
	Name      string             `json:"name,omitempty"`
	Variables json.RawMessage    `json:"variables,omitempty"` // preserved, not in public API
	Children  []internalTreeNode `json:"children,omitempty"`
}

type internalTree struct {
	Children []internalTreeNode `json:"children"`
}

// internalToStore converts an internalTreeNode to a store.TreeNode,
// stripping Variables.
func internalToStore(n internalTreeNode) store.TreeNode {
	node := store.TreeNode{ID: n.ID, Type: n.Type, Name: n.Name}
	for _, c := range n.Children {
		node.Children = append(node.Children, internalToStore(c))
	}
	return node
}

// storeToInternal converts a store.TreeNode to an internalTreeNode,
// restoring Variables for known folder IDs from varsIdx.
func storeToInternal(n store.TreeNode, varsIdx map[string]json.RawMessage) internalTreeNode {
	in := internalTreeNode{
		ID:        n.ID,
		Type:      n.Type,
		Name:      n.Name,
		Variables: varsIdx[n.ID],
	}
	for _, c := range n.Children {
		in.Children = append(in.Children, storeToInternal(c, varsIdx))
	}
	return in
}

// buildVarsIndex walks an internalTree and collects folder variables.
func buildVarsIndex(nodes []internalTreeNode, idx map[string]json.RawMessage) {
	for _, n := range nodes {
		if n.Type == "folder" && len(n.Variables) > 0 {
			idx[n.ID] = n.Variables
		}
		buildVarsIndex(n.Children, idx)
	}
}

// ── Collection metadata format ──────────────────────────────────────────────

// collectionMetadata is the on-disk format for collections/<collID>/metadata.json.
type collectionMetadata struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Variables json.RawMessage `json:"variables,omitempty"`
}

// ── Legacy environment format (EnvironmentStore compat) ────────────────────
//
// The EnvironmentStore must still serve and accept the old monolithic
// environment blob so existing HTTP handlers remain unchanged.
// These types mirror the old rsEnvDoc / rsCollDoc, prefixed with "legacy".

type legacyEnvDoc struct {
	Version     int             `json:"version"`
	Collections []legacyCollDoc `json:"collections"`
	Variables   json.RawMessage `json:"variables,omitempty"`
}

type legacyCollDoc struct {
	ID        string            `json:"id"`
	Type      string            `json:"type"`
	Name      string            `json:"name"`
	Children  []json.RawMessage `json:"children,omitempty"`
	Variables json.RawMessage   `json:"variables,omitempty"`
}

type legacyNodePeek struct {
	ID   string `json:"id"`
	Type string `json:"type"`
}
