package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
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

// binaryItems lists the synthetic binary payloads served under /binary/<name>.
// Each body is generated in-process (no external asset files) so the renderer's
// image-preview, PDF-preview and hex-dump branches from feature 35 can all be
// exercised offline. The set spans the image/* branch (png/jpeg/gif), the
// application/pdf branch, and a generic application/octet-stream that should
// fall through to the hex+ASCII viewer.
var binaryItems = []struct {
	Name, Type string
}{
	{"png", "image/png"},
	{"jpeg", "image/jpeg"},
	{"gif", "image/gif"},
	{"pdf", "application/pdf"},
	{"octet-stream", "application/octet-stream"},
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

	http.HandleFunc("/binary", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/binary" {
			http.NotFound(w, r)
			return
		}
		// Index of the binary payloads, mirroring /mimes and /volume.
		type api struct {
			Name string `json:"name"`
			Path string `json:"path"`
			Type string `json:"type"`
		}
		list := make([]api, len(binaryItems))
		for i, b := range binaryItems {
			list[i] = api{b.Name, "/binary/" + b.Name, b.Type}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"service":  "wurl-mock",
			"binaries": list,
		})
	})

	http.HandleFunc("/binary/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/binary/")
		body, ctype, ok := binaryBody(name)
		if !ok {
			http.Error(w, "unknown binary type", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", ctype)
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.Write(body)
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

// binaryBody returns the raw bytes and Content-Type for a /binary/<name>
// payload. The bool is false for an unknown name. Images share one generated
// gradient bitmap so the three encoders exercise distinct decode paths in the
// renderer; the PDF and octet-stream bodies are built byte-exact.
func binaryBody(name string) ([]byte, string, bool) {
	switch name {
	case "png":
		return encodeImage(name, gradientImage()), "image/png", true
	case "jpeg":
		return encodeImage(name, gradientImage()), "image/jpeg", true
	case "gif":
		return encodeImage(name, gradientImage()), "image/gif", true
	case "pdf":
		return minimalPDF(), "application/pdf", true
	case "octet-stream":
		return octetStream(), "application/octet-stream", true
	default:
		return nil, "", false
	}
}

// gradientImage builds a 256x256 RGBA bitmap whose channels vary with x/y so
// the encoded output is visually obvious and non-trivial to compress.
func gradientImage() image.Image {
	const w, h = 256, 256
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: uint8((x + y) / 2), A: 255})
		}
	}
	return img
}

// encodeImage encodes img in the format named by name (png/jpeg/gif).
func encodeImage(name string, img image.Image) []byte {
	var buf bytes.Buffer
	switch name {
	case "jpeg":
		_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90})
	case "gif":
		_ = gif.Encode(&buf, img, nil)
	default:
		_ = png.Encode(&buf, img)
	}
	return buf.Bytes()
}

// minimalPDF builds a single-page PDF with a correct cross-reference table so
// strict viewers (Chromium's pdfium) render it. Object offsets are computed as
// the body is assembled rather than hardcoded.
func minimalPDF() []byte {
	content := "BT /F1 24 Tf 20 60 Td (wurl mock PDF) Tj ET"
	objs := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	}
	var buf bytes.Buffer
	buf.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objs)+1)
	for i, body := range objs {
		offsets[i+1] = buf.Len()
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", i+1, body)
	}
	xrefPos := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n", len(objs)+1)
	buf.WriteString("0000000000 65535 f \n")
	for i := 1; i <= len(objs); i++ {
		fmt.Fprintf(&buf, "%010d 00000 n \n", offsets[i])
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, xrefPos)
	return buf.Bytes()
}

// octetStream returns 512 bytes that include every value 0x00-0xFF so the hex
// viewer's offset, hex and ASCII columns all have something to render.
func octetStream() []byte {
	b := make([]byte, 512)
	for i := range b {
		b[i] = uint8(i)
	}
	return b
}
