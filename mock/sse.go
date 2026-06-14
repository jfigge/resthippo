package main

// sse.go — Server-Sent Events / streaming test endpoints (feature 33).
//
// Standard-library only (no deps), matching auth.go / graphql.go / websocket.go.
// Each streaming handler sets the streaming headers, writes the status, and
// flushes after every frame so the client (wurl's live response viewer) sees
// data arrive incrementally instead of all at once at the end. Loops honor
// r.Context().Done() so a client disconnect (the Stop button → req.destroy)
// tears the goroutine down promptly.
//
// Endpoints (registered from server.go):
//
//	/sse            JSON index of the streams below (not a stream itself)
//	/sse/events     periodic JSON events with `event:` / `id:` fields
//	/sse/counter    plain `message` events (data is a bare number)
//	/sse/llm        simulated LLM token stream, OpenAI-style, ending with [DONE]
//	/sse/infinite   never-ending tick stream + keep-alive comments (use Stop)
//	/ndjson         chunked NDJSON — NOT text/event-stream (use the Stream toggle)
//
// Common query params: count (events to emit), interval (ms between events).

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// sseItems is the discovery index served at /sse, mirroring /mimes, /volume and
// /binary. Type is the Content-Type each endpoint responds with.
var sseItems = []struct {
	Name, Path, Type, Desc string
}{
	{"events", "/sse/events", "text/event-stream", "Periodic JSON events with event/id fields"},
	{"counter", "/sse/counter", "text/event-stream", "Plain message events (data is a bare number)"},
	{"llm", "/sse/llm", "text/event-stream", "Simulated LLM token stream ending with [DONE]"},
	{"infinite", "/sse/infinite", "text/event-stream", "Never-ending stream — use Stop to end it"},
	{"ndjson", "/ndjson", "application/x-ndjson", "Chunked NDJSON — enable the Stream toggle"},
}

func registerSSERoutes() {
	http.HandleFunc("/sse", sseIndexHandler)
	http.HandleFunc("/sse/events", sseEventsHandler)
	http.HandleFunc("/sse/counter", sseCounterHandler)
	http.HandleFunc("/sse/llm", sseLLMHandler)
	http.HandleFunc("/sse/infinite", sseInfiniteHandler)
	http.HandleFunc("/ndjson", ndjsonHandler)
}

// sseIndexHandler lists the available streaming endpoints as JSON.
func sseIndexHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/sse" {
		http.NotFound(w, r)
		return
	}
	type api struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Type string `json:"type"`
		Desc string `json:"description"`
	}
	list := make([]api, len(sseItems))
	for i, s := range sseItems {
		list[i] = api{s.Name, s.Path, s.Type, s.Desc}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"service": "wurl-mock",
		"streams": list,
	})
}

// streamSetup writes the streaming headers + 200 status and returns a flusher.
// ok is false when the ResponseWriter can't flush (the client then gets a 500),
// which never happens with Go's default server but keeps the handlers honest.
func streamSetup(w http.ResponseWriter, contentType string) (http.Flusher, bool) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return nil, false
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// Defeat any intermediary (e.g. the mock's forward proxy) buffering the body.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fl.Flush()
	return fl, true
}

// intQuery reads an int query param, clamped to [lo, hi], with a default.
func intQuery(r *http.Request, key string, def, lo, hi int) int {
	n, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		return def
	}
	if n < lo {
		n = lo
	}
	if n > hi {
		n = hi
	}
	return n
}

// sseEventsHandler emits `count` JSON events, one every `interval` ms, each with
// a named event type, an incrementing id, and a JSON data payload — the typical
// shape of a structured SSE feed.
func sseEventsHandler(w http.ResponseWriter, r *http.Request) {
	count := intQuery(r, "count", 12, 1, 10000)
	interval := intQuery(r, "interval", 500, 0, 60000)
	fl, ok := streamSetup(w, "text/event-stream")
	if !ok {
		return
	}
	fmt.Fprintf(w, ": stream open — %d events every %dms\n\n", count, interval)
	fl.Flush()

	for i := 1; i <= count; i++ {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Duration(interval) * time.Millisecond):
		}
		payload, _ := json.Marshal(map[string]any{
			"seq":     i,
			"total":   count,
			"message": fmt.Sprintf("event %d of %d", i, count),
			"ts":      time.Now().UnixMilli(),
		})
		fmt.Fprintf(w, "event: tick\nid: %d\ndata: %s\n\n", i, payload)
		fl.Flush()
	}
	fmt.Fprint(w, "event: done\ndata: {\"ok\":true}\n\n")
	fl.Flush()
}

// sseCounterHandler emits bare default ("message") events whose data is just the
// running count — exercises the untagged-event path in the viewer.
func sseCounterHandler(w http.ResponseWriter, r *http.Request) {
	count := intQuery(r, "count", 20, 1, 10000)
	interval := intQuery(r, "interval", 300, 0, 60000)
	fl, ok := streamSetup(w, "text/event-stream")
	if !ok {
		return
	}
	for i := 1; i <= count; i++ {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Duration(interval) * time.Millisecond):
		}
		fmt.Fprintf(w, "data: %d\n\n", i)
		fl.Flush()
	}
}

// sseLLMHandler simulates an LLM chat completion token stream in the OpenAI
// `chat.completion.chunk` shape: a role delta, then one content delta per token,
// a final stop chunk, and the terminating `data: [DONE]` sentinel.
func sseLLMHandler(w http.ResponseWriter, r *http.Request) {
	interval := intQuery(r, "interval", 90, 0, 60000)
	fl, ok := streamSetup(w, "text/event-stream")
	if !ok {
		return
	}

	const id = "chatcmpl-mock"
	chunk := func(delta map[string]any, finish any) {
		payload, _ := json.Marshal(map[string]any{
			"id":      id,
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   "wurl-mock-1",
			"choices": []map[string]any{{
				"index":         0,
				"delta":         delta,
				"finish_reason": finish,
			}},
		})
		fmt.Fprintf(w, "data: %s\n\n", payload)
		fl.Flush()
	}

	// Opening role delta.
	chunk(map[string]any{"role": "assistant"}, nil)

	text := "Streaming responses let wurl show tokens the moment they arrive, " +
		"instead of waiting for the whole reply. Press Stop to cancel at any time."
	for _, tok := range strings.SplitAfter(text, " ") {
		if tok == "" {
			continue
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Duration(interval) * time.Millisecond):
		}
		chunk(map[string]any{"content": tok}, nil)
	}

	chunk(map[string]any{}, "stop")
	fmt.Fprint(w, "data: [DONE]\n\n")
	fl.Flush()
}

// sseInfiniteHandler streams forever: a tick every `interval` ms plus a `:`
// keep-alive comment between ticks, until the client disconnects. Use it to test
// the Stop button, bounded in-memory log, and save-while-running.
func sseInfiniteHandler(w http.ResponseWriter, r *http.Request) {
	interval := intQuery(r, "interval", 1000, 50, 60000)
	fl, ok := streamSetup(w, "text/event-stream")
	if !ok {
		return
	}
	fmt.Fprint(w, ": infinite stream — press Stop to end it\n\n")
	fl.Flush()

	for i := 1; ; i++ {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Duration(interval) * time.Millisecond):
		}
		payload, _ := json.Marshal(map[string]any{
			"tick": i,
			"ts":   time.Now().UnixMilli(),
		})
		fmt.Fprintf(w, "event: tick\nid: %d\ndata: %s\n\n", i, payload)
		fl.Flush()
	}
}

// ndjsonHandler streams newline-delimited JSON (one object per line), flushed per
// line, as application/x-ndjson. This is NOT text/event-stream, so it does not
// auto-stream — enable the request's Stream toggle to consume it live.
func ndjsonHandler(w http.ResponseWriter, r *http.Request) {
	count := intQuery(r, "count", 20, 1, 10000)
	interval := intQuery(r, "interval", 300, 0, 60000)
	fl, ok := streamSetup(w, "application/x-ndjson")
	if !ok {
		return
	}
	for i := 1; i <= count; i++ {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Duration(interval) * time.Millisecond):
		}
		line, _ := json.Marshal(map[string]any{
			"seq":   i,
			"total": count,
			"level": []string{"info", "warn", "error"}[i%3],
			"msg":   fmt.Sprintf("log line %d", i),
			"ts":    time.Now().UnixMilli(),
		})
		fmt.Fprintf(w, "%s\n", line)
		fl.Flush()
	}
}
