package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf16"
)

// auth.go — mock endpoints for exercising every authentication scheme wurl
// supports: Basic, Bearer, API Key, Digest, AWS Signature v4 ("AWS CLI") and
// NTLM. Each endpoint validates that the credentials are *well-formed* for the
// scheme (it does NOT check them against any real secret) and echoes the parsed
// values back as a JSON document so the client can confirm what it sent.
//
//	GET /auth          → list the supported auth types
//	GET /auth/<type>   → validate + echo the credentials for <type>
//
// Digest and NTLM require a challenge/response handshake, so an unauthenticated
// request to those endpoints answers 401 with the appropriate WWW-Authenticate
// header; wurl then retries with credentials.

// authTypes is the catalogue advertised by GET /auth, in display order.
var authTypes = []struct{ Type, Desc string }{
	{"basic", "HTTP Basic — Authorization: Basic base64(user:pass)"},
	{"bearer", "Bearer token — Authorization: Bearer <token>"},
	{"apikey", "API key — header (X-API-Key / api-key) or query (api_key / apikey / key)"},
	{"digest", "HTTP Digest — challenge/response, Authorization: Digest <fields>"},
	{"aws", "AWS Signature v4 — Authorization: AWS4-HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=..."},
	{"ntlm", "NTLM — challenge/response, Authorization: NTLM base64(NTLMSSP message)"},
}

// registerAuthRoutes wires the /auth endpoints onto the default mux. Called
// from main().
func registerAuthRoutes() {
	http.HandleFunc("/auth", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth" {
			http.NotFound(w, r)
			return
		}
		type entry struct {
			Type        string `json:"type"`
			Description string `json:"description"`
		}
		list := make([]entry, len(authTypes))
		for i, a := range authTypes {
			list[i] = entry{a.Type, a.Desc}
		}
		writeJSON(w, http.StatusOK, list)
	})

	http.HandleFunc("/auth/", func(w http.ResponseWriter, r *http.Request) {
		typ := strings.ToLower(strings.TrimPrefix(r.URL.Path, "/auth/"))
		switch typ {
		case "basic":
			authBasic(w, r)
		case "bearer":
			authBearer(w, r)
		case "apikey", "api-key", "api_key":
			authAPIKey(w, r)
		case "digest":
			authDigest(w, r)
		case "aws", "aws-iam", "awsv4", "aws-cli":
			authAWS(w, r)
		case "ntlm":
			authNTLM(w, r)
		default:
			writeError(w, http.StatusNotFound, fmt.Sprintf("unknown auth type %q", typ))
		}
	})
}

// ── helpers ──────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"error": msg, "status": code})
}

// authOK echoes a successful, well-formed credential as a uniform document.
func authOK(w http.ResponseWriter, typ, scheme string, creds map[string]any, raw string) {
	writeJSON(w, http.StatusOK, map[string]any{
		"type":          typ,
		"scheme":        scheme,
		"authenticated": true,
		"credentials":   creds,
		"raw":           raw,
	})
}

// randomHex returns n random bytes hex-encoded, for nonces/challenges.
func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// ── Basic ────────────────────────────────────────────────────────────────────

func authBasic(w http.ResponseWriter, r *http.Request) {
	h := r.Header.Get("Authorization")
	if h == "" {
		w.Header().Set("WWW-Authenticate", `Basic realm="wurl-mock"`)
		writeError(w, http.StatusUnauthorized, "missing Authorization header")
		return
	}
	rest, ok := schemeValue(h, "Basic")
	if !ok {
		writeError(w, http.StatusBadRequest, "expected 'Basic <base64(user:pass)>'")
		return
	}
	decoded, err := base64.StdEncoding.DecodeString(rest)
	if err != nil {
		writeError(w, http.StatusBadRequest, "credentials are not valid base64")
		return
	}
	user, pass, found := strings.Cut(string(decoded), ":")
	if !found {
		writeError(w, http.StatusBadRequest, "decoded credentials must be 'user:password'")
		return
	}
	authOK(w, "basic", "Basic", map[string]any{
		"username": user,
		"password": pass,
	}, h)
}

// ── Bearer ───────────────────────────────────────────────────────────────────

func authBearer(w http.ResponseWriter, r *http.Request) {
	h := r.Header.Get("Authorization")
	if h == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="wurl-mock"`)
		writeError(w, http.StatusUnauthorized, "missing Authorization header")
		return
	}
	token, ok := schemeValue(h, "Bearer")
	if !ok || token == "" {
		writeError(w, http.StatusBadRequest, "expected 'Bearer <token>'")
		return
	}
	authOK(w, "bearer", "Bearer", map[string]any{
		"token": token,
	}, h)
}

// ── API Key ──────────────────────────────────────────────────────────────────

func authAPIKey(w http.ResponseWriter, r *http.Request) {
	// wurl lets the user choose the carrier (header name or query param), so we
	// accept the conventional spellings and report where the key arrived.
	headerNames := []string{"X-API-Key", "Api-Key", "X-Api-Key", "Apikey","X-Auth-Token"}
	for _, name := range headerNames {
		if v := r.Header.Get(name); v != "" {
			authOK(w, "apikey", "", map[string]any{
				"in":    "header",
				"name":  name,
				"value": v,
			}, name+": "+v)
			return
		}
	}
	queryNames := []string{"api_key", "apikey", "api-key", "key"}
	q := r.URL.Query()
	for _, name := range queryNames {
		if q.Has(name) {
			v := q.Get(name)
			authOK(w, "apikey", "", map[string]any{
				"in":    "query",
				"name":  name,
				"value": v,
			}, name+"="+v)
			return
		}
	}
	writeError(w, http.StatusUnauthorized,
		"no API key found — send one of headers ["+strings.Join(headerNames, ", ")+
			"] or query params ["+strings.Join(queryNames, ", ")+"]")
}

// ── Digest ───────────────────────────────────────────────────────────────────

func authDigest(w http.ResponseWriter, r *http.Request) {
	h := r.Header.Get("Authorization")
	scheme, ok := schemeValue(h, "Digest")
	if h == "" || !ok {
		// Issue a fresh challenge.
		w.Header().Set("WWW-Authenticate", fmt.Sprintf(
			`Digest realm="wurl-mock", qop="auth", nonce="%s", opaque="%s", algorithm=MD5`,
			randomHex(16), randomHex(8)))
		writeError(w, http.StatusUnauthorized, "digest challenge issued — retry with credentials")
		return
	}
	fields := parseDigestFields(scheme)
	required := []string{"username", "realm", "nonce", "uri", "response"}
	var missing []string
	for _, k := range required {
		if fields[k] == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		writeError(w, http.StatusBadRequest,
			"malformed Digest credentials — missing: "+strings.Join(missing, ", "))
		return
	}
	creds := make(map[string]any, len(fields))
	for k, v := range fields {
		creds[k] = v
	}
	authOK(w, "digest", "Digest", creds, h)
}

// parseDigestFields parses a comma-separated `k=v` / `k="v"` Digest credential
// list into a map.
func parseDigestFields(s string) map[string]string {
	out := map[string]string{}
	for _, part := range splitDigest(s) {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		v = strings.Trim(v, `"`)
		out[strings.ToLower(strings.TrimSpace(k))] = v
	}
	return out
}

// splitDigest splits on commas that sit outside of double-quoted values.
func splitDigest(s string) []string {
	var parts []string
	var b strings.Builder
	inQuote := false
	for _, r := range s {
		switch {
		case r == '"':
			inQuote = !inQuote
			b.WriteRune(r)
		case r == ',' && !inQuote:
			parts = append(parts, b.String())
			b.Reset()
		default:
			b.WriteRune(r)
		}
	}
	if b.Len() > 0 {
		parts = append(parts, b.String())
	}
	return parts
}

// ── AWS Signature v4 ("AWS CLI") ───────────────────────────────────────────────

func authAWS(w http.ResponseWriter, r *http.Request) {
	h := r.Header.Get("Authorization")
	if h == "" {
		writeError(w, http.StatusUnauthorized, "missing Authorization header")
		return
	}
	rest, ok := schemeValue(h, "AWS4-HMAC-SHA256")
	if !ok {
		writeError(w, http.StatusBadRequest, "expected 'AWS4-HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=...'")
		return
	}
	// Comma-separated key=value pairs: Credential, SignedHeaders, Signature.
	pairs := map[string]string{}
	for _, part := range strings.Split(rest, ",") {
		k, v, found := strings.Cut(strings.TrimSpace(part), "=")
		if found {
			pairs[strings.ToLower(strings.TrimSpace(k))] = strings.TrimSpace(v)
		}
	}
	cred := pairs["credential"]
	signedHeaders := pairs["signedheaders"]
	signature := pairs["signature"]
	if cred == "" || signedHeaders == "" || signature == "" {
		writeError(w, http.StatusBadRequest,
			"AWS v4 requires Credential, SignedHeaders and Signature components")
		return
	}
	creds := map[string]any{
		"credential":      cred,
		"signedHeaders":   strings.Split(signedHeaders, ";"),
		"signature":       signature,
		"xAmzDate":        r.Header.Get("X-Amz-Date"),
		"xAmzSecurityTok": r.Header.Get("X-Amz-Security-Token") != "",
	}
	// Credential scope: <access-key>/<date>/<region>/<service>/aws4_request
	if scope := strings.Split(cred, "/"); len(scope) == 5 {
		creds["accessKeyId"] = scope[0]
		creds["date"] = scope[1]
		creds["region"] = scope[2]
		creds["service"] = scope[3]
		creds["terminator"] = scope[4]
	} else {
		writeError(w, http.StatusBadRequest,
			"Credential must be '<access-key>/<date>/<region>/<service>/aws4_request'")
		return
	}
	authOK(w, "aws", "AWS4-HMAC-SHA256", creds, h)
}

// ── NTLM ───────────────────────────────────────────────────────────────────────

func authNTLM(w http.ResponseWriter, r *http.Request) {
	h := r.Header.Get("Authorization")
	msg, ok := schemeValue(h, "NTLM")
	if h == "" || !ok {
		// No NTLM message yet — ask the client to begin the handshake.
		w.Header().Set("WWW-Authenticate", "NTLM")
		writeError(w, http.StatusUnauthorized, "NTLM negotiation required — retry with a Type 1 message")
		return
	}
	raw, err := base64.StdEncoding.DecodeString(msg)
	if err != nil {
		writeError(w, http.StatusBadRequest, "NTLM message is not valid base64")
		return
	}
	if len(raw) < 12 || string(raw[:8]) != "NTLMSSP\x00" {
		writeError(w, http.StatusBadRequest, "not a valid NTLMSSP message (bad signature)")
		return
	}
	msgType := binary.LittleEndian.Uint32(raw[8:12])
	switch msgType {
	case 1:
		// Type 1 (Negotiate) → reply with a Type 2 challenge and stay in 401.
		w.Header().Set("WWW-Authenticate", "NTLM "+ntlmType2Challenge())
		writeError(w, http.StatusUnauthorized, "NTLM Type 2 challenge issued — retry with a Type 3 message")
		return
	case 3:
		// Type 3 (Authenticate) → parse the identity fields and accept.
		domain := ntlmField(raw, 28)
		user := ntlmField(raw, 36)
		workstation := ntlmField(raw, 44)
		authOK(w, "ntlm", "NTLM", map[string]any{
			"messageType": 3,
			"domain":      domain,
			"username":    user,
			"workstation": workstation,
		}, h)
		return
	default:
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("unsupported NTLM message type %d (expected 1 or 3)", msgType))
	}
}

// ntlmType2Challenge builds a minimal, valid base64 NTLMSSP Type 2 message with
// an 8-byte server challenge. It carries no target info — enough for a client
// to proceed to Type 3.
func ntlmType2Challenge() string {
	msg := make([]byte, 32)
	copy(msg, "NTLMSSP\x00")
	binary.LittleEndian.PutUint32(msg[8:], 2) // message type 2
	// 12..19: target name security buffer (empty)
	// 20..23: negotiate flags — request Unicode + NTLM.
	binary.LittleEndian.PutUint32(msg[20:], 0x00000201)
	copy(msg[24:], randomBytes(8)) // 24..31: server challenge
	return base64.StdEncoding.EncodeToString(msg)
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}

// ntlmField reads the security buffer at the given header offset and decodes the
// referenced string. NTLM identity strings are UTF-16LE when the Unicode flag is
// negotiated (the common case); we fall back to raw bytes otherwise.
func ntlmField(raw []byte, off int) string {
	if len(raw) < off+8 {
		return ""
	}
	length := int(binary.LittleEndian.Uint16(raw[off:]))
	start := int(binary.LittleEndian.Uint32(raw[off+4:]))
	if length == 0 || start+length > len(raw) {
		return ""
	}
	data := raw[start : start+length]
	// Heuristic: even length with NUL high bytes ⇒ UTF-16LE.
	if length%2 == 0 {
		u16 := make([]uint16, length/2)
		for i := 0; i < length; i += 2 {
			u16[i/2] = binary.LittleEndian.Uint16(data[i:])
		}
		return string(utf16.Decode(u16))
	}
	return string(data)
}

// ── shared scheme parsing ──────────────────────────────────────────────────────

// schemeValue splits "Scheme value" and returns the value if the scheme matches
// (case-insensitively). For schemes whose value itself contains spaces (Digest,
// AWS) the full remainder is returned.
func schemeValue(header, scheme string) (string, bool) {
	prefix := scheme + " "
	if len(header) < len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", false
	}
	return strings.TrimSpace(header[len(prefix):]), true
}
