package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"html"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// addr is the main HTTP API listen address, overridable via MOCK_PORT (see
// listenAddr in proxy.go and the shared dev.env in the Makefile).
var addr = listenAddr("MOCK_PORT", ":8888")

var mimes = []struct{ Type, Body string }{
	{"application/json",
		`{"status":"ok","service":"resthippo-mock","version":"1.0","items":[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]}`},
	{"application/vnd.api+json",
		`{"data":{"type":"users","id":"1","attributes":{"name":"Alice","role":"admin"}},"meta":{"total":1}}`},
	{"application/yaml",
		"service: resthippo-mock\nversion: \"1.0\"\nfeatures:\n  - json\n  - yaml\n  - xml\n  - html\n  - css\n  - javascript\n"},
	{"application/x-yaml",
		"---\nname: config\ndatabase:\n  host: localhost\n  port: 5432\n  name: Rest Hippo\n"},
	{"application/xml",
		`<?xml version="1.0" encoding="UTF-8"?><response><status>ok</status><items><item id="1"><name>Alice</name></item><item id="2"><name>Bob</name></item></items></response>`},
	{"application/xhtml+xml",
		`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Rest Hippo</title></head><body><h1>Mock Server</h1><p>XHTML response.</p></body></html>`},
	{"text/html",
		"<!DOCTYPE html>\n<html>\n<head><title>Rest Hippo mock</title></head>\n<body>\n  <h1>Mock Server</h1>\n  <p>Mock response from the Rest Hippo test server.</p>\n  <ul><li>JSON</li><li>YAML</li><li>XML</li><li>HTML</li><li>CSS</li><li>JavaScript</li></ul>\n</body>\n</html>\n"},
	{"text/css",
		"body {\n  font-family: sans-serif;\n  color: #333;\n  margin: 0;\n}\n\nh1 {\n  color: steelblue;\n  border-bottom: 2px solid #ccc;\n}\n\n.api-response {\n  padding: 1rem;\n  background: #f5f5f5;\n  border-radius: 4px;\n}\n"},
	{"text/javascript",
		"function fetchData(url) {\n  return fetch(url)\n    .then(r => r.json())\n    .then(data => {\n      console.log('Received:', data);\n      return data;\n    });\n}\n\nfetchData('http://localhost:8888/mimes').then(console.log);\n"},
	{"application/ecmascript",
		"export class MockClient {\n  #base;\n  constructor(base) { this.#base = base; }\n  async get(path) { return (await fetch(this.#base + path)).json(); }\n  async mimes() { return this.get('/mimes'); }\n}\n"},
	{"text/markdown",
		"# Rest Hippo Mock Server\n\nA **mock response** from the Rest Hippo test server.\n\n## Supported MIME types\n\n- `application/json`\n- `application/yaml`\n- `application/xml`\n- `text/html`\n- `text/css`\n- `text/markdown`\n\n## Example\n\n```js\nfetch('http://localhost:8888/mimes/text/markdown')\n  .then(r => r.text())\n  .then(console.log);\n```\n\n> See the [/mimes](http://localhost:8888/mimes) endpoint for the full list.\n\n| Code | Meaning |\n| ---- | ------- |\n| 200  | OK      |\n| 404  | Not Found |\n"},
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
			"service": "resthippo-mock",
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
			"service":  "resthippo-mock",
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

	// /delay sleeps for the requested number of seconds (clamped to [1, 30])
	// before returning, so the client's loading state, timing waterfall and
	// timeout/cancel handling can be exercised against a known delay.
	http.HandleFunc("/delay", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/delay" {
			http.NotFound(w, r)
			return
		}
		// seconds is required and must be an integer; "" (missing) also errors.
		requested, err := strconv.Atoi(r.URL.Query().Get("seconds"))
		if err != nil {
			http.Error(w, "invalid or missing 'seconds' query parameter (integer required)", http.StatusBadRequest)
			return
		}
		// Clamp to [1, 30]: <=1 -> 1, >=30 -> 30.
		secs := requested
		if secs < 1 {
			secs = 1
		}
		if secs > 30 {
			secs = 30
		}
		time.Sleep(time.Duration(secs) * time.Second)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"requested": requested, // raw value before clamping (shows the clamp)
			"delayed":   secs,      // seconds actually slept
			"unit":      "seconds",
		})
	})

	// /echo reflects the incoming request (any method, custom verbs included)
	// back to the caller; see echoHandler. Both the exact path and its subtree
	// are registered so trailing path segments are accepted too.
	http.HandleFunc("/echo", echoHandler)
	http.HandleFunc("/echo/", echoHandler)

	registerAuthRoutes()
	registerGraphqlRoutes()
	registerWebsocketRoutes()
	registerSSERoutes()

	// Forward proxy (feature 44) on its own port and handler, sharing this
	// process so a single `make mock-up` brings both up.
	go startProxyServer()

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
	head := fmt.Sprintf(`{"status":"ok","service":"resthippo-mock","payload":%q,"items":[`, payload)
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
	content := "BT /F1 24 Tf 20 60 Td (Rest Hippo mock PDF) Tj ET"
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

// ----------------------------------------------------------------------------
// /echo — request reflection
// ----------------------------------------------------------------------------

// maxEchoBody caps how much request body the echo endpoint reads back into its
// response so a stray large upload can't exhaust memory. Bodies beyond this are
// truncated and flagged via echoData.BodyTruncated.
const maxEchoBody = 16 << 20 // 16 MiB

// echoData is the reflected view of an incoming request returned by /echo. The
// struct field order is the output order for every format; map keys within
// params, headers and cookies are emitted sorted so responses are stable.
type echoData struct {
	Method        string              `json:"method"`
	URL           string              `json:"url"`
	Path          string              `json:"path"`
	Protocol      string              `json:"protocol"`
	Host          string              `json:"host"`
	RemoteAddr    string              `json:"remoteAddr"`
	Params        map[string][]string `json:"params"`
	Headers       map[string][]string `json:"headers"`
	Cookies       map[string]string   `json:"cookies"`
	ContentLength int64               `json:"contentLength"`
	BodyTruncated bool                `json:"bodyTruncated,omitempty"`
	Body          string              `json:"body"`
}

// echoHandler reflects the incoming request back to the caller. It works for any
// HTTP method (including custom verbs, since net/http puts the raw method token
// in r.Method without restricting it to the standard set) and serialises the
// reflection as JSON by default, or as XML, YAML or HTML when the Accept header
// asks for one of those.
func echoHandler(w http.ResponseWriter, r *http.Request) {
	body, truncated := readEchoBody(r)

	cookies := map[string]string{}
	for _, c := range r.Cookies() {
		cookies[c.Name] = c.Value
	}

	data := echoData{
		Method:        r.Method,
		URL:           r.URL.RequestURI(),
		Path:          r.URL.Path,
		Protocol:      r.Proto,
		Host:          r.Host,
		RemoteAddr:    r.RemoteAddr,
		Params:        map[string][]string(r.URL.Query()),
		Headers:       map[string][]string(r.Header),
		Cookies:       cookies,
		ContentLength: r.ContentLength,
		BodyTruncated: truncated,
		Body:          string(body),
	}

	switch echoFormat(r.Header.Get("Accept")) {
	case "xml":
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		_, _ = io.WriteString(w, echoXML(data))
	case "yaml":
		w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
		_, _ = io.WriteString(w, echoYAML(data))
	case "html":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, echoHTML(data))
	default:
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		_ = enc.Encode(data)
	}
}

// readEchoBody drains up to maxEchoBody bytes of the request body, reporting
// whether it was truncated. A nil body (e.g. a GET) yields an empty string.
func readEchoBody(r *http.Request) (body []byte, truncated bool) {
	if r.Body == nil {
		return nil, false
	}
	defer r.Body.Close()
	body, _ = io.ReadAll(io.LimitReader(r.Body, maxEchoBody+1))
	if len(body) > maxEchoBody {
		return body[:maxEchoBody], true
	}
	return body, false
}

// echoFormat picks the response format from the Accept header. It walks the
// comma-separated media types in client-preference order and returns the first
// that maps to a format rendered specially (xml/yaml/html); anything else —
// including application/json, */*, or a missing header — falls through to json.
// html is checked before xml so application/xhtml+xml resolves to html.
func echoFormat(accept string) string {
	for _, part := range strings.Split(accept, ",") {
		mt := strings.ToLower(strings.TrimSpace(part))
		if i := strings.IndexByte(mt, ';'); i >= 0 {
			mt = strings.TrimSpace(mt[:i])
		}
		switch {
		case strings.Contains(mt, "yaml"):
			return "yaml"
		case strings.Contains(mt, "html"):
			return "html"
		case strings.Contains(mt, "xml"):
			return "xml"
		case strings.Contains(mt, "json"):
			return "json"
		}
	}
	return "json"
}

// sortedKeys returns the keys of m in ascending order, for stable output.
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// echoXML renders the reflection as an XML document. encoding/xml handles all
// content/attribute escaping; the maps are flattened into named-element slices
// because xml can't marshal maps directly.
func echoXML(d echoData) string {
	type xmlNamed struct {
		Name   string   `xml:"name,attr"`
		Values []string `xml:"value"`
	}
	type xmlCookie struct {
		Name  string `xml:"name,attr"`
		Value string `xml:",chardata"`
	}
	type xmlEcho struct {
		XMLName       xml.Name    `xml:"echo"`
		Method        string      `xml:"method"`
		URL           string      `xml:"url"`
		Path          string      `xml:"path"`
		Protocol      string      `xml:"protocol"`
		Host          string      `xml:"host"`
		RemoteAddr    string      `xml:"remoteAddr"`
		Params        []xmlNamed  `xml:"params>param"`
		Headers       []xmlNamed  `xml:"headers>header"`
		Cookies       []xmlCookie `xml:"cookies>cookie"`
		ContentLength int64       `xml:"contentLength"`
		BodyTruncated bool        `xml:"bodyTruncated,omitempty"`
		Body          string      `xml:"body"`
	}
	out := xmlEcho{
		Method: d.Method, URL: d.URL, Path: d.Path, Protocol: d.Protocol,
		Host: d.Host, RemoteAddr: d.RemoteAddr, ContentLength: d.ContentLength,
		BodyTruncated: d.BodyTruncated, Body: d.Body,
	}
	for _, k := range sortedKeys(d.Params) {
		out.Params = append(out.Params, xmlNamed{Name: k, Values: d.Params[k]})
	}
	for _, k := range sortedKeys(d.Headers) {
		out.Headers = append(out.Headers, xmlNamed{Name: k, Values: d.Headers[k]})
	}
	for _, k := range sortedKeys(d.Cookies) {
		out.Cookies = append(out.Cookies, xmlCookie{Name: k, Value: d.Cookies[k]})
	}
	buf, err := xml.MarshalIndent(out, "", "  ")
	if err != nil {
		return xml.Header + "<echo><error>" + html.EscapeString(err.Error()) + "</error></echo>\n"
	}
	return xml.Header + string(buf) + "\n"
}

// echoYAML renders the reflection as YAML. Every scalar is double-quoted (see
// yamlScalar) so the encoder needs no type analysis and stays dependency-free.
func echoYAML(d echoData) string {
	var b strings.Builder
	b.WriteString("method: " + yamlScalar(d.Method) + "\n")
	b.WriteString("url: " + yamlScalar(d.URL) + "\n")
	b.WriteString("path: " + yamlScalar(d.Path) + "\n")
	b.WriteString("protocol: " + yamlScalar(d.Protocol) + "\n")
	b.WriteString("host: " + yamlScalar(d.Host) + "\n")
	b.WriteString("remoteAddr: " + yamlScalar(d.RemoteAddr) + "\n")
	writeYAMLMultiMap(&b, "params", d.Params)
	writeYAMLMultiMap(&b, "headers", d.Headers)
	writeYAMLStringMap(&b, "cookies", d.Cookies)
	b.WriteString("contentLength: " + strconv.FormatInt(d.ContentLength, 10) + "\n")
	if d.BodyTruncated {
		b.WriteString("bodyTruncated: true\n")
	}
	b.WriteString("body: " + yamlScalar(d.Body) + "\n")
	return b.String()
}

// writeYAMLMultiMap emits a name → {key → [values]} block, or "name: {}" when
// the map is empty.
func writeYAMLMultiMap(b *strings.Builder, name string, m map[string][]string) {
	if len(m) == 0 {
		b.WriteString(name + ": {}\n")
		return
	}
	b.WriteString(name + ":\n")
	for _, k := range sortedKeys(m) {
		b.WriteString("  " + yamlScalar(k) + ":\n")
		for _, v := range m[k] {
			b.WriteString("    - " + yamlScalar(v) + "\n")
		}
	}
}

// writeYAMLStringMap emits a name → {key → value} block, or "name: {}" when the
// map is empty.
func writeYAMLStringMap(b *strings.Builder, name string, m map[string]string) {
	if len(m) == 0 {
		b.WriteString(name + ": {}\n")
		return
	}
	b.WriteString(name + ":\n")
	for _, k := range sortedKeys(m) {
		b.WriteString("  " + yamlScalar(k) + ": " + yamlScalar(m[k]) + "\n")
	}
}

// yamlScalar renders s as a YAML double-quoted scalar, valid for any string
// including empty, multi-line, or values that would otherwise read as a number
// or boolean.
func yamlScalar(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// echoHTML renders the reflection as a small standalone HTML page. All dynamic
// values are escaped with html.EscapeString.
func echoHTML(d echoData) string {
	esc := html.EscapeString
	var b strings.Builder
	b.WriteString("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n")
	b.WriteString("<meta charset=\"utf-8\">\n<title>Rest Hippo echo</title>\n")
	b.WriteString("<style>\n")
	b.WriteString("body{font-family:system-ui,sans-serif;margin:2rem;color:#222}\n")
	b.WriteString("h1{border-bottom:2px solid #ccc;padding-bottom:.25rem}\n")
	b.WriteString("table{border-collapse:collapse;width:100%}\n")
	b.WriteString("th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;vertical-align:top}\n")
	b.WriteString("th{width:10rem;background:#f5f5f5}\n")
	b.WriteString("ul{margin:0;padding-left:1.2rem}\n")
	b.WriteString("pre{margin:0;white-space:pre-wrap;word-break:break-word}\n")
	b.WriteString("</style>\n</head>\n<body>\n")
	b.WriteString("<h1>echo</h1>\n<table>\n")
	row := func(k, v string) {
		b.WriteString("<tr><th>" + esc(k) + "</th><td>" + v + "</td></tr>\n")
	}
	row("method", esc(d.Method))
	row("url", esc(d.URL))
	row("path", esc(d.Path))
	row("protocol", esc(d.Protocol))
	row("host", esc(d.Host))
	row("remoteAddr", esc(d.RemoteAddr))
	row("params", htmlMultiMap(d.Params))
	row("headers", htmlMultiMap(d.Headers))
	row("cookies", htmlStringMap(d.Cookies))
	row("contentLength", esc(strconv.FormatInt(d.ContentLength, 10)))
	if d.BodyTruncated {
		row("bodyTruncated", "true")
	}
	row("body", "<pre>"+esc(d.Body)+"</pre>")
	b.WriteString("</table>\n</body>\n</html>\n")
	return b.String()
}

// htmlMultiMap renders a key → [values] map as a nested <ul>, escaping each part.
func htmlMultiMap(m map[string][]string) string {
	if len(m) == 0 {
		return "<em>(none)</em>"
	}
	esc := html.EscapeString
	var b strings.Builder
	b.WriteString("<ul>")
	for _, k := range sortedKeys(m) {
		b.WriteString("<li><strong>" + esc(k) + "</strong>: " + esc(strings.Join(m[k], ", ")) + "</li>")
	}
	b.WriteString("</ul>")
	return b.String()
}

// htmlStringMap renders a key → value map as a nested <ul>, escaping each part.
func htmlStringMap(m map[string]string) string {
	if len(m) == 0 {
		return "<em>(none)</em>"
	}
	esc := html.EscapeString
	var b strings.Builder
	b.WriteString("<ul>")
	for _, k := range sortedKeys(m) {
		b.WriteString("<li><strong>" + esc(k) + "</strong>: " + esc(m[k]) + "</li>")
	}
	b.WriteString("</ul>")
	return b.String()
}
