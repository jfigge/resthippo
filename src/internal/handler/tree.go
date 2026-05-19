package handler

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"wurl/internal/store"
)

// GetCollectionTree returns an http.HandlerFunc for:
//
//	GET /api/collections/{id}/tree
//
// The {id} path value is the environment ID. The response is a lightweight
// JSON tree containing only folder structure and request IDs – no request
// definitions are included, making it suitable for populating navigation
// sidebars without paying the cost of loading full request payloads.
func GetCollectionTree(ts store.TreeStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		envID := r.PathValue("id")
		if envID == "" || !isValidEnvID(envID) {
			http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
			return
		}

		tree, err := ts.GetTree(r.Context(), envID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
				return
			}
			log.Printf("[handler] get tree %s: %v", envID, err)
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(tree)
	}
}

// PutCollectionTree returns an http.HandlerFunc for:
//
//	PUT /api/collections/{id}/tree
//
// The {id} path value is the environment ID. The request body must be a JSON
// object matching the CollectionTree shape:
//
//	{
//	  "children": [
//	    { "id": "folder-1", "type": "folder", "name": "Auth",
//	      "children": [
//	        { "id": "req-123", "type": "requestRef" }
//	      ]
//	    }
//	  ]
//	}
//
// The handler replaces the collection navigation structure for the environment
// while preserving full request data for every requestRef that remains in the
// new tree. Returns 400 if the body is malformed, 404 if a requestRef
// references an unknown request ID, and 204 on success.
func PutCollectionTree(ts store.TreeStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		envID := r.PathValue("id")
		if envID == "" || !isValidEnvID(envID) {
			http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
			return
		}

		var tree store.CollectionTree
		if err := json.NewDecoder(r.Body).Decode(&tree); err != nil {
			http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
			return
		}

		if err := validateTreeNodes(tree.Children, 0); err != nil {
			http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusBadRequest)
			return
		}

		if err := ts.SaveTree(r.Context(), envID, &tree); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				http.Error(w, `{"error":"one or more requestRef IDs not found"}`, http.StatusNotFound)
				return
			}
			log.Printf("[handler] put tree %s: %v", envID, err)
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// validateTreeNodes performs a shallow structural check on incoming tree nodes:
//   - every node must have a non-empty id and a known type
//   - top-level nodes (depth 0) must be folders
//   - folder nodes must have a non-empty name
//   - requestRef nodes must not carry children
//
// depth tracks nesting level (0 = top-level children of CollectionTree).
func validateTreeNodes(nodes []store.TreeNode, depth int) error {
	for _, n := range nodes {
		if n.ID == "" {
			return errors.New("tree node missing id")
		}
		switch n.Type {
		case "folder":
			if n.Name == "" {
				return errors.New("folder node missing name")
			}
			if err := validateTreeNodes(n.Children, depth+1); err != nil {
				return err
			}
		case "requestRef":
			if depth == 0 {
				return errors.New("requestRef node at top level; must be inside a folder")
			}
			if len(n.Children) > 0 {
				return errors.New("requestRef node must not have children")
			}
		default:
			return errors.New("unknown tree node type: " + n.Type)
		}
	}
	return nil
}
