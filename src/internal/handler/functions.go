package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/itchyny/gojq"
)

// Functions returns an http.HandlerFunc for POST /api/functions/invoke.
//
// Request body:  { "fn": string, "args": { key: value, … } }
// Response body: { "result": string }  |  { "error": string }
func Functions() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if r.Method != http.MethodPost {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			Fn   string                 `json:"fn"`
			Args map[string]interface{} `json:"args"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
			return
		}

		result, err := invokeFunction(req.Fn, req.Args)
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"result": result})
	}
}

func invokeFunction(fn string, args map[string]interface{}) (string, error) {
	str := func(key string) string {
		v, _ := args[key].(string)
		return v
	}

	switch fn {
	case "jq":
		return evalJq(str("json"), str("query"))
	case "hmac":
		return evalHmac(str("algo"), str("key"), str("message"))
	case "hash":
		return evalHash(str("algo"), str("value"))
	default:
		return "", fmt.Errorf("unknown function: %s", fn)
	}
}

func evalJq(jsonStr, query string) (string, error) {
	var data interface{}
	if err := json.Unmarshal([]byte(jsonStr), &data); err != nil {
		return "", fmt.Errorf("invalid JSON: %v", err)
	}

	q, err := gojq.Parse(query)
	if err != nil {
		return "", fmt.Errorf("invalid jq query: %v", err)
	}

	iter := q.Run(data)
	v, ok := iter.Next()
	if !ok {
		return "", nil
	}
	if e, ok := v.(error); ok {
		return "", e
	}

	if s, ok := v.(string); ok {
		return s, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func evalHmac(algo, key, message string) (string, error) {
	switch algo {
	case "SHA256":
		mac := hmac.New(sha256.New, []byte(key))
		mac.Write([]byte(message))
		return hex.EncodeToString(mac.Sum(nil)), nil
	case "SHA512":
		mac := hmac.New(sha512.New, []byte(key))
		mac.Write([]byte(message))
		return hex.EncodeToString(mac.Sum(nil)), nil
	default:
		return "", fmt.Errorf("unsupported HMAC algorithm: %s (use SHA256 or SHA512)", algo)
	}
}

func evalHash(algo, value string) (string, error) {
	switch algo {
	case "SHA256":
		h := sha256.Sum256([]byte(value))
		return hex.EncodeToString(h[:]), nil
	case "SHA512":
		h := sha512.New()
		h.Write([]byte(value))
		return hex.EncodeToString(h.Sum(nil)), nil
	default:
		return "", fmt.Errorf("unsupported hash algorithm: %s (use SHA256 or SHA512)", algo)
	}
}
