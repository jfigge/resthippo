package handler

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"wurl/internal/store"
)

// GetRequest returns an http.HandlerFunc for GET /api/requests/{id}.
//
// Path value  {id}  must be present and consist only of UUID-safe characters.
// Responds with the full request JSON on success, or 404 if the ID is unknown.
func GetRequest(rs store.RequestStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" || !isValidEnvID(id) {
			http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
			return
		}

		req, err := rs.GetRequest(r.Context(), id)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
				return
			}
			log.Printf("[handler] get request %s: %v", id, err)
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(req)
	}
}

// CreateRequest returns an http.HandlerFunc for POST /api/requests.
//
// Request body must be a JSON object containing at minimum:
//
//	environmentId  – ID of the environment that owns the target collection.
//	collectionId   – ID of the collection to append the request to.
//	name           – Human-readable request name.
//
// Method defaults to "GET" when omitted. The assigned (or provided) request ID
// is returned in the 201 response body.
func CreateRequest(rs store.RequestStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Buffer the body once so we can decode it into two different structs.
		var raw json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
			return
		}

		// Extract routing fields (environmentId / collectionId).
		var loc struct {
			EnvironmentID string `json:"environmentId"`
			CollectionID  string `json:"collectionId"`
		}
		if err := json.Unmarshal(raw, &loc); err != nil {
			http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
			return
		}
		if loc.EnvironmentID == "" || loc.CollectionID == "" {
			http.Error(w, `{"error":"environmentId and collectionId are required"}`, http.StatusBadRequest)
			return
		}
		if !isValidEnvID(loc.EnvironmentID) || !isValidEnvID(loc.CollectionID) {
			http.Error(w, `{"error":"invalid environmentId or collectionId"}`, http.StatusBadRequest)
			return
		}

		// Decode the request payload.
		var req store.Request
		if err := json.Unmarshal(raw, &req); err != nil {
			http.Error(w, `{"error":"invalid request payload"}`, http.StatusBadRequest)
			return
		}
		if req.Name == "" {
			http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
			return
		}
		if req.Method == "" {
			req.Method = "GET"
		}
		req.Type = "request"

		if err := rs.CreateRequest(r.Context(), loc.EnvironmentID, loc.CollectionID, &req); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				http.Error(w, `{"error":"environment or collection not found"}`, http.StatusNotFound)
				return
			}
			log.Printf("[handler] create request: %v", err)
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(&req)
	}
}

// PatchRequest returns an http.HandlerFunc for PATCH /api/requests/{id}.
//
// The request body is a JSON object whose fields are merged into the stored
// request. Only supplied fields are updated; absent fields are left unchanged.
// For slice fields (params, headers, bodyFormRows) an explicit empty array
// clears the list, while an absent key leaves it intact.
//
// Responds with the full updated request on success.
func PatchRequest(rs store.RequestStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" || !isValidEnvID(id) {
			http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
			return
		}

		var patch store.RequestPatch
		if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
			http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
			return
		}

		if err := rs.UpdateRequest(r.Context(), id, patch); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
				return
			}
			log.Printf("[handler] patch request %s: %v", id, err)
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		// Return the current state of the request after the patch.
		req, err := rs.GetRequest(r.Context(), id)
		if err != nil {
			// Patch succeeded but read-back failed; return 204 rather than 500.
			w.WriteHeader(http.StatusNoContent)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(req)
	}
}

// DeleteRequest returns an http.HandlerFunc for DELETE /api/requests/{id}.
//
// Responds with 204 No Content on success, or 404 if the ID is unknown.
func DeleteRequest(rs store.RequestStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" || !isValidEnvID(id) {
			http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
			return
		}

		if err := rs.DeleteRequest(r.Context(), id); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
				return
			}
			log.Printf("[handler] delete request %s: %v", id, err)
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
