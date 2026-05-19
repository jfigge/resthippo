// Package handler contains HTTP handler constructors for the wurl API.
//
// Each handler depends only on its corresponding store interface, never on
// filesystem paths or other concrete storage details. This keeps handlers
// independently unit-testable via simple in-memory store fakes.
package handler

import (
	"encoding/json"
	"log"
	"net/http"

	"wurl/internal/store"
)

// Collections returns an http.HandlerFunc that handles the /api/collections
// endpoint using the supplied CollectionStore.
//
// Supported methods:
//
//	GET  – return the full manifest as JSON.
//	PUT  – validate and atomically persist an updated manifest.
func Collections(cs store.CollectionStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch r.Method {
		case http.MethodGet:
			data, err := cs.GetManifest(r.Context())
			if err != nil {
				log.Printf("[handler] collections get: %v", err)
				http.Error(w, `{"error":"failed to read collections"}`, http.StatusInternalServerError)
				return
			}
			_, _ = w.Write(data)

		case http.MethodPut:
			var payload json.RawMessage
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
				return
			}
			if err := cs.SaveManifest(r.Context(), payload); err != nil {
				log.Printf("[handler] collections save: %v", err)
				http.Error(w, `{"error":"failed to write collections"}`, http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)

		default:
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		}
	}
}

// Environment returns an http.HandlerFunc that handles the /api/env endpoint
// using the supplied EnvironmentStore.
//
// Supported methods:
//
//	GET  – return the environment data for the given ?id= query parameter.
//	PUT  – validate and atomically persist updated environment data.
func Environment(es store.EnvironmentStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		id := r.URL.Query().Get("id")
		if id == "" {
			http.Error(w, `{"error":"missing id parameter"}`, http.StatusBadRequest)
			return
		}
		// Sanitise: only UUID characters allowed (prevents path traversal).
		if !isValidEnvID(id) {
			http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
			return
		}

		switch r.Method {
		case http.MethodGet:
			data, err := es.GetEnvironment(r.Context(), id)
			if err != nil {
				log.Printf("[handler] env get %s: %v", id, err)
				http.Error(w, `{"error":"failed to read environment"}`, http.StatusInternalServerError)
				return
			}
			_, _ = w.Write(data)

		case http.MethodPut:
			var payload json.RawMessage
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
				return
			}
			if err := es.SaveEnvironment(r.Context(), id, payload); err != nil {
				log.Printf("[handler] env save %s: %v", id, err)
				http.Error(w, `{"error":"failed to write environment"}`, http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)

		default:
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		}
	}
}

// isValidEnvID reports whether id contains only UUID-safe characters
// (alphanumeric and hyphen), preventing directory-traversal attacks.
func isValidEnvID(id string) bool {
	for _, c := range id {
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '-' {
			return false
		}
	}
	return true
}
