package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
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
}

func main() {
	idx := make(map[string]int, len(mimes))
	for i, m := range mimes {
		idx[strings.ToLower(m.Type)] = i
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
		key = strings.ToLower(key)
		i, ok := idx[key]
		if !ok {
			http.Error(w, "unknown mime type", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", mimes[i].Type)
		fmt.Fprint(w, mimes[i].Body)
	})

	fmt.Fprintln(os.Stderr, "mock server listening on", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
