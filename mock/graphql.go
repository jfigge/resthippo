package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// graphql.go — a deliberately small mock GraphQL endpoint for exercising wurl's
// GraphQL body mode (Feature 34). It is NOT a real GraphQL engine: it answers
// the standard introspection query with a canned schema, returns canned data for
// the handful of root fields that schema declares, and returns a GraphQL
// `errors` array for anything it doesn't recognise so the editor's error path
// can be exercised too.
//
//	POST /graphql   body: { "query": "...", "variables": {...}, "operationName": "..." }
//	GET  /graphql?query=...&variables=...   (introspection / simple queries)
//
// Schema served:
//	type Query    { user(id: ID!): User   users(role: Role, active: Boolean): [User!]! }
//	type Mutation { createUser(name: String!, role: Role): User }
//	type User     { id: ID!  name: String!  email: String!  role: Role  active: Boolean }
//	enum Role     { ADMIN  USER  GUEST }

const maxGraphQLBody = 1 << 20 // 1 MiB — introspection responses are small

type gqlRequest struct {
	Query         string         `json:"query"`
	Variables     map[string]any `json:"variables"`
	OperationName string         `json:"operationName"`
}

// registerGraphqlRoutes wires the /graphql endpoint onto the default mux. Called
// from main().
func registerGraphqlRoutes() {
	http.HandleFunc("/graphql", graphqlHandler)
}

func graphqlHandler(w http.ResponseWriter, r *http.Request) {
	var req gqlRequest
	switch r.Method {
	case http.MethodGet:
		req.Query = r.URL.Query().Get("query")
		if v := r.URL.Query().Get("variables"); v != "" {
			_ = json.Unmarshal([]byte(v), &req.Variables)
		}
	case http.MethodPost:
		body, _ := io.ReadAll(io.LimitReader(r.Body, maxGraphQLBody))
		if err := json.Unmarshal(body, &req); err != nil {
			writeGraphQLError(w, http.StatusBadRequest, "request body is not valid JSON")
			return
		}
	default:
		writeGraphQLError(w, http.StatusMethodNotAllowed, "GraphQL endpoint accepts GET or POST")
		return
	}

	q := req.Query
	if strings.TrimSpace(q) == "" {
		writeGraphQLError(w, http.StatusBadRequest, "no GraphQL query provided")
		return
	}

	// Introspection — answer with the canned schema verbatim.
	if strings.Contains(q, "__schema") || strings.Contains(q, "IntrospectionQuery") {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = io.WriteString(w, introspectionJSON)
		return
	}

	// Otherwise dispatch on the first known root field named in the query. The
	// checks are word-boundary aware so "user" does not match "users".
	switch {
	case mentionsField(q, "createUser"):
		writeJSON(w, http.StatusOK, map[string]any{
			"data": map[string]any{
				"createUser": userObj(
					"100",
					strVar(req.Variables, "name", "New User"),
					strVar(req.Variables, "role", "USER"),
					true,
				),
			},
		})
	case mentionsField(q, "users"):
		writeJSON(w, http.StatusOK, map[string]any{
			"data": map[string]any{
				"users": []any{
					userObj("1", "Alice", "ADMIN", true),
					userObj("2", "Bob", "USER", false),
				},
			},
		})
	case mentionsField(q, "user"):
		writeJSON(w, http.StatusOK, map[string]any{
			"data": map[string]any{
				"user": userObj(strVar(req.Variables, "id", "1"), "Alice", "ADMIN", true),
			},
		})
	default:
		// Unknown field — GraphQL convention is HTTP 200 with an errors array.
		writeJSON(w, http.StatusOK, map[string]any{
			"errors": []any{
				map[string]any{
					"message": "Cannot query the requested field on type \"Query\".",
				},
			},
		})
	}
}

func userObj(id, name, role string, active bool) map[string]any {
	return map[string]any{
		"id":     id,
		"name":   name,
		"email":  strings.ToLower(strings.ReplaceAll(name, " ", ".")) + "@example.com",
		"role":   role,
		"active": active,
	}
}

func strVar(vars map[string]any, key, def string) string {
	if vars != nil {
		if v, ok := vars[key]; ok {
			if s, ok := v.(string); ok && s != "" {
				return s
			}
		}
	}
	return def
}

func writeGraphQLError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{
		"errors": []any{map[string]any{"message": msg}},
	})
}

// mentionsField reports whether `field` appears in `q` as a whole identifier
// (not as a substring of a longer name like "users" vs "user").
func mentionsField(q, field string) bool {
	for idx := 0; ; {
		i := strings.Index(q[idx:], field)
		if i < 0 {
			return false
		}
		i += idx
		var before, after byte = ' ', ' '
		if i > 0 {
			before = q[i-1]
		}
		if i+len(field) < len(q) {
			after = q[i+len(field)]
		}
		if !isIdentByte(before) && !isIdentByte(after) {
			return true
		}
		idx = i + len(field)
	}
}

func isIdentByte(b byte) bool {
	return b == '_' ||
		(b >= 'a' && b <= 'z') ||
		(b >= 'A' && b <= 'Z') ||
		(b >= '0' && b <= '9')
}

// introspectionJSON is the canned response to the standard introspection query.
// It mirrors the schema documented at the top of this file in the shape wurl's
// buildSchemaModel() consumes (kind/name/fields[args,type]/enumValues + ofType
// chains for wrappers).
const introspectionJSON = `{
  "data": {
    "__schema": {
      "queryType": { "name": "Query" },
      "mutationType": { "name": "Mutation" },
      "subscriptionType": null,
      "types": [
        {
          "kind": "OBJECT",
          "name": "Query",
          "fields": [
            {
              "name": "user",
              "args": [
                { "name": "id", "type": { "kind": "NON_NULL", "name": null, "ofType": { "kind": "SCALAR", "name": "ID", "ofType": null } } }
              ],
              "type": { "kind": "OBJECT", "name": "User", "ofType": null }
            },
            {
              "name": "users",
              "args": [
                { "name": "role", "type": { "kind": "ENUM", "name": "Role", "ofType": null } },
                { "name": "active", "type": { "kind": "SCALAR", "name": "Boolean", "ofType": null } }
              ],
              "type": { "kind": "NON_NULL", "name": null, "ofType": { "kind": "LIST", "name": null, "ofType": { "kind": "NON_NULL", "name": null, "ofType": { "kind": "OBJECT", "name": "User", "ofType": null } } } }
            }
          ],
          "inputFields": null,
          "enumValues": null
        },
        {
          "kind": "OBJECT",
          "name": "Mutation",
          "fields": [
            {
              "name": "createUser",
              "args": [
                { "name": "name", "type": { "kind": "NON_NULL", "name": null, "ofType": { "kind": "SCALAR", "name": "String", "ofType": null } } },
                { "name": "role", "type": { "kind": "ENUM", "name": "Role", "ofType": null } }
              ],
              "type": { "kind": "OBJECT", "name": "User", "ofType": null }
            }
          ],
          "inputFields": null,
          "enumValues": null
        },
        {
          "kind": "OBJECT",
          "name": "User",
          "fields": [
            { "name": "id", "args": [], "type": { "kind": "NON_NULL", "name": null, "ofType": { "kind": "SCALAR", "name": "ID", "ofType": null } } },
            { "name": "name", "args": [], "type": { "kind": "NON_NULL", "name": null, "ofType": { "kind": "SCALAR", "name": "String", "ofType": null } } },
            { "name": "email", "args": [], "type": { "kind": "NON_NULL", "name": null, "ofType": { "kind": "SCALAR", "name": "String", "ofType": null } } },
            { "name": "role", "args": [], "type": { "kind": "ENUM", "name": "Role", "ofType": null } },
            { "name": "active", "args": [], "type": { "kind": "SCALAR", "name": "Boolean", "ofType": null } }
          ],
          "inputFields": null,
          "enumValues": null
        },
        {
          "kind": "ENUM",
          "name": "Role",
          "fields": null,
          "inputFields": null,
          "enumValues": [ { "name": "ADMIN" }, { "name": "USER" }, { "name": "GUEST" } ]
        },
        { "kind": "SCALAR", "name": "ID", "fields": null, "inputFields": null, "enumValues": null },
        { "kind": "SCALAR", "name": "String", "fields": null, "inputFields": null, "enumValues": null },
        { "kind": "SCALAR", "name": "Boolean", "fields": null, "inputFields": null, "enumValues": null }
      ]
    }
  }
}`
