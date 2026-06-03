package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
)

const addr = ":8888"

var mimes = []struct{ Type, Body string }{
	{"application/json",
		`{"status":"ok","service":"wurl-mock","version":"1.0","items":[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]}`},
	{"application/vnd.api+json",
		`{"data":{"type":"users","id":"1","attributes":{"name":"Alice","role":"admin"}},"meta":{"total":1}}`},
	{"application/yaml",
		"service: wurl-mock\nversion: \"1.0\"\nfeatures:\n  - json\n  - yaml\n  - xml\n  - html\n  - css\n  - javascript\n"},
	{"application/x-yaml",
		"---\nname: config\ndatabase:\n  host: localhost\n  port: 5432\n  name: wurl\n"},
	{"application/xml",
		`<?xml version="1.0" encoding="UTF-8"?><response><status>ok</status><items><item id="1"><name>Alice</name></item><item id="2"><name>Bob</name></item></items></response>`},
	{"application/xhtml+xml",
		`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>wurl</title></head><body><h1>Mock Server</h1><p>XHTML response.</p></body></html>`},
	{"text/html",
		"<!DOCTYPE html>\n<html>\n<head><title>wurl mock</title></head>\n<body>\n  <h1>Mock Server</h1>\n  <p>Mock response from the wurl test server.</p>\n  <ul><li>JSON</li><li>YAML</li><li>XML</li><li>HTML</li><li>CSS</li><li>JavaScript</li></ul>\n</body>\n</html>\n"},
	{"text/css",
		"body {\n  font-family: sans-serif;\n  color: #333;\n  margin: 0;\n}\n\nh1 {\n  color: steelblue;\n  border-bottom: 2px solid #ccc;\n}\n\n.api-response {\n  padding: 1rem;\n  background: #f5f5f5;\n  border-radius: 4px;\n}\n"},
	{"text/javascript",
		"function fetchData(url) {\n  return fetch(url)\n    .then(r => r.json())\n    .then(data => {\n      console.log('Received:', data);\n      return data;\n    });\n}\n\nfetchData('http://localhost:8888/mimes').then(console.log);\n"},
	{"application/ecmascript",
		"export class MockClient {\n  #base;\n  constructor(base) { this.#base = base; }\n  async get(path) { return (await fetch(this.#base + path)).json(); }\n  async mimes() { return this.get('/mimes'); }\n}\n"},
	{"text/markdown",
		"# wurl Mock Server\n\nA **mock response** from the wurl test server.\n\n## Supported MIME types\n\n- `application/json`\n- `application/yaml`\n- `application/xml`\n- `text/html`\n- `text/css`\n- `text/markdown`\n\n## Example\n\n```js\nfetch('http://localhost:8888/mimes/text/markdown')\n  .then(r => r.text())\n  .then(console.log);\n```\n\n> See the [/mimes](http://localhost:8888/mimes) endpoint for the full list.\n\n| Code | Meaning |\n| ---- | ------- |\n| 200  | OK      |\n| 404  | Not Found |\n"},
}

var statuses = []int{
	100, 101, 102, 103,
	200, 201, 202, 203, 204, 205, 206, 207, 208, 226,
	300, 301, 302, 303, 304, 307, 308,
	400, 401, 402, 403, 404, 405, 406, 407, 408, 409,
	410, 411, 412, 413, 414, 415, 416, 417, 418,
	421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
	500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511,
}

// volumeSizes lists the synthetic JSON payloads served under /volume/<name>,
// each emitted at exactly the given byte size. The sizes straddle the
// renderer's 8 MB spill threshold and 16 MB inline limit so the in-memory,
// streaming/preview and save-to-file paths can all be exercised from here.
var volumeSizes = []struct {
	Name  string
	Bytes int
}{
	{"small", 1 * 1024 * 1024},
	{"medium", 15 * 1024 * 1024},
	{"large", 28 * 1024 * 1024},
}

func main() {
	// build mime index keyed by subtype ("json", "vnd.api+json", etc.)
	mimeIdx := make(map[string]int, len(mimes))
	for i, m := range mimes {
		mimeIdx[strings.ToLower(m.Type)] = i
	}

	http.HandleFunc("/mimes", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mimes" {
			http.NotFound(w, r)
			return
		}
		keys := make([]string, len(mimes))
		for i, m := range mimes {
			keys[i] = strings.ToLower(m.Type)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(keys)
	})

	http.HandleFunc("/mimes/", func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/mimes/")
		i, ok := mimeIdx[key]
		if !ok {
			http.Error(w, "unknown mime type", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", mimes[i].Type)
		fmt.Fprint(w, mimes[i].Body)
	})

	http.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/status" {
			http.NotFound(w, r)
			return
		}
		type entry struct {
			Code int    `json:"code"`
			Text string `json:"text"`
		}
		list := make([]entry, len(statuses))
		for i, code := range statuses {
			list[i] = entry{code, http.StatusText(code)}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(list)
	})

	http.HandleFunc("/status/", func(w http.ResponseWriter, r *http.Request) {
		s := strings.TrimPrefix(r.URL.Path, "/status/")
		code, err := strconv.Atoi(s)
		if err != nil || http.StatusText(code) == "" {
			http.Error(w, "unknown status code", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		// 204 No Content and 304 Not Modified must have no body
		if code != http.StatusNoContent && code != http.StatusNotModified {
			json.NewEncoder(w).Encode(map[string]any{
				"status": code,
				"text":   http.StatusText(code),
			})
		}
	})

	http.HandleFunc("/volume", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/volume" {
			http.NotFound(w, r)
			return
		}
		// Index of the volume payloads and their exact sizes.
		type api struct {
			Name  string `json:"name"`
			Path  string `json:"path"`
			Bytes int    `json:"bytes"`
			Size  string `json:"size"`
		}
		list := make([]api, len(volumeSizes))
		for i, v := range volumeSizes {
			list[i] = api{v.Name, "/volume/" + v.Name, v.Bytes, humanSize(v.Bytes)}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"service": "wurl-mock",
			"volumes": list,
		})
	})

	http.HandleFunc("/volume/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/volume/")
		for _, v := range volumeSizes {
			if v.Name == name {
				// Each payload is emitted at exactly v.Bytes. The sizes are
				// chosen to straddle the renderer's 8 MB spill threshold and
				// 16 MB inline limit: small (1 MB) stays in memory; medium
				// (15 MB) spills to the on-disk cache yet still renders inline
				// via "View full"; large (28 MB) spills across 3+ cached pages
				// and exceeds the inline limit, routing "View full" to save.
				writeVolumeJSON(w, v.Name, v.Bytes)
				return
			}
		}
		http.Error(w, "unknown volume size", http.StatusNotFound)
	})

	registerAuthRoutes()

	fmt.Fprintln(os.Stderr, "mock server listening on", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// humanSize renders a byte count as a compact MB/KB/B label. The volume sizes
// are exact power-of-two multiples, so this yields clean "1MB"/"15MB"/"28MB".
func humanSize(n int) string {
	switch {
	case n >= 1024*1024:
		return fmt.Sprintf("%dMB", n/(1024*1024))
	case n >= 1024:
		return fmt.Sprintf("%dKB", n/1024)
	default:
		return fmt.Sprintf("%dB", n)
	}
}

// writeVolumeJSON streams a syntactically valid JSON object of exactly
// targetBytes to w, tagged with payload. The body is generated record by
// record (never buffered whole) and a final filler record is padded so the
// total length lands exactly on target.
func writeVolumeJSON(w http.ResponseWriter, payload string, targetBytes int) {
	head := fmt.Sprintf(`{"status":"ok","service":"wurl-mock","payload":%q,"items":[`, payload)
	const tail = `]}`
	w.Header().Set("Content-Type", "application/json")
	bw := bufio.NewWriter(w)
	written := 0
	n, _ := io.WriteString(bw, head)
	written += n
	// Reserve room for the closing tail so the final length lands exactly.
	for i := 0; written < targetBytes-len(tail); i++ {
		rec := fmt.Sprintf(
			`{"id":%d,"name":"Item-%07d","uuid":"%08x-aaaa-bbbb-cccc-%012x","email":"user%07d@example.com","active":%t,"score":%d,"note":"lorem ipsum dolor sit amet consectetur adipiscing elit"}`,
			i, i, i, i, i, i%2 == 0, (i*7)%1000)
		if i > 0 {
			rec = "," + rec
		}
		// When a full record would overshoot, emit one padded filler record
		// sized to consume exactly the remaining bytes, then stop.
		remaining := targetBytes - len(tail) - written
		if len(rec) > remaining {
			sep := ""
			if i > 0 {
				sep = ","
			}
			prefix := fmt.Sprintf(`%s{"id":%d,"pad":"`, sep, i)
			suffix := `"}`
			padLen := remaining - len(prefix) - len(suffix)
			if padLen < 0 {
				// No room for even an empty filler — pad with insignificant
				// whitespace before the closing tail instead.
				_, _ = io.WriteString(bw, strings.Repeat(" ", remaining))
				break
			}
			_, _ = io.WriteString(bw, prefix+strings.Repeat("x", padLen)+suffix)
			break
		}
		n, _ = io.WriteString(bw, rec)
		written += n
	}
	_, _ = io.WriteString(bw, tail)
	_ = bw.Flush()
}
