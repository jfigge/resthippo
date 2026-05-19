package handler

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"

	"wurl/internal/store"
)

const (
	defaultHistoryLimit = 20
	maxHistoryLimit     = 100
)

// ListHistory returns an http.HandlerFunc for:
//
//	GET /api/requests/{id}/history[?limit=N&cursor=TOKEN]
//
// Returns a HistoryPage containing lightweight metadata entries (no response
// bodies) in newest-first order. Pagination is cursor-based:
//
//   - limit  – entries per page, 1–100, default 20.
//   - cursor – opaque value from a previous response's nextCursor field;
//     omit (or leave empty) to start from the most recent entry.
func ListHistory(hs store.HistoryStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		requestID := r.PathValue("id")
		if requestID == "" || !isValidEnvID(requestID) {
			http.Error(w, `{"error":"invalid request id"}`, http.StatusBadRequest)
			return
		}

		// Parse ?limit= (optional, default 20).
		limit := defaultHistoryLimit
		if ls := r.URL.Query().Get("limit"); ls != "" {
			n, err := strconv.Atoi(ls)
			if err != nil || n < 1 || n > maxHistoryLimit {
				http.Error(w, `{"error":"limit must be an integer between 1 and 100"}`, http.StatusBadRequest)
				return
			}
			limit = n
		}

		cursor := r.URL.Query().Get("cursor")
		// Cursor is opaque but must be UUID-safe to prevent injection.
		if cursor != "" && !isValidEnvID(cursor) {
			http.Error(w, `{"error":"invalid cursor"}`, http.StatusBadRequest)
			return
		}

		page, err := hs.ListHistory(r.Context(), requestID, limit, cursor)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
				return
			}
			log.Printf("[handler] list history %s: %v", requestID, err)
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(page)
	}
}

// AddHistory returns an http.HandlerFunc for:
//
//	POST /api/requests/{id}/history
//
// Records one execution of the request identified by {id}. The body must be a
// JSON object carrying both history metadata and the full response payload:
//
//	{
//	  "status":       200,
//	  "statusText":   "OK",
//	  "durationMs":   184,
//	  "responseSize": 48192,
//	  "headers":      { "Content-Type": "application/json" },
//	  "body":         "..."
//	}
//
// status is required. All other fields are optional/zero-valued by default.
//
// Responds 201 Created with the saved HistoryEntry metadata (no body).
func AddHistory(hs store.HistoryStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		requestID := r.PathValue("id")
		if requestID == "" || !isValidEnvID(requestID) {
			http.Error(w, `{"error":"invalid request id"}`, http.StatusBadRequest)
			return
		}

		var body struct {
			Status       int               `json:"status"`
			StatusText   string            `json:"statusText"`
			DurationMs   int64             `json:"durationMs"`
			ResponseSize int64             `json:"responseSize"`
			Headers      map[string]string `json:"headers"`
			Body         string            `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
			return
		}
		if body.Status == 0 {
			http.Error(w, `{"error":"status is required and must be non-zero"}`, http.StatusBadRequest)
			return
		}

		entry := &store.HistoryEntry{
			RequestID:    requestID,
			Status:       body.Status,
			DurationMs:   body.DurationMs,
			ResponseSize: body.ResponseSize,
		}
		resp := &store.HistoryResponse{
			RequestID:  requestID,
			StatusText: body.StatusText,
			Headers:    body.Headers,
			Body:       body.Body,
		}

		if err := hs.AddHistory(r.Context(), entry, resp); err != nil {
			log.Printf("[handler] add history %s: %v", requestID, err)
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(entry)
	}
}

// GetHistoryResponse returns an http.HandlerFunc for:
//
//	GET /api/requests/{id}/history/{historyId}/response
//
// Lazy-loads the full response payload for one history entry. The metadata
// for the entry (status, durationMs, etc.) is available cheaply via
// GET /api/requests/{id}/history; this endpoint is called only when the user
// actually wants to view the response body.
func GetHistoryResponse(hs store.HistoryStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		requestID := r.PathValue("id")
		historyID := r.PathValue("historyId")

		if requestID == "" || !isValidEnvID(requestID) {
			http.Error(w, `{"error":"invalid request id"}`, http.StatusBadRequest)
			return
		}
		if historyID == "" || !isValidEnvID(historyID) {
			http.Error(w, `{"error":"invalid history id"}`, http.StatusBadRequest)
			return
		}

		resp, err := hs.GetHistoryResponse(r.Context(), requestID, historyID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
				return
			}
			log.Printf("[handler] get history response %s/%s: %v", requestID, historyID, err)
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}
