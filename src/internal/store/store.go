// Package store defines storage interfaces for wurl's persistence layer.
//
// The interfaces decouple HTTP handlers from any particular storage backend
// (filesystem, database, in-memory, …), making each layer independently
// testable via mocks or fakes.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// ErrNotFound is returned when a requested resource does not exist.
var ErrNotFound = errors.New("not found")

// ──────────────────────────────────────────────────────────────────────────────
// CollectionStore
// ──────────────────────────────────────────────────────────────────────────────

// CollectionStore manages the top-level collections manifest.
//
// In the current filesystem implementation this corresponds to a single
// "collections.json" file that records the named environments, the active
// environment ID, and global application settings.
type CollectionStore interface {
	// GetManifest returns the full manifest as raw JSON.
	// Implementations must return a sensible default when no manifest has been
	// persisted yet (e.g. on first run).
	GetManifest(ctx context.Context) (json.RawMessage, error)

	// SaveManifest atomically persists the full manifest.
	SaveManifest(ctx context.Context, data json.RawMessage) error
}

// ──────────────────────────────────────────────────────────────────────────────
// EnvironmentStore
// ──────────────────────────────────────────────────────────────────────────────

// EnvironmentStore manages per-environment data.
//
// Each environment contains a tree of collections and requests together with
// environment-scoped variable definitions. In the current filesystem
// implementation each environment is stored as "<id>.json" under the data
// directory.
type EnvironmentStore interface {
	// GetEnvironment returns the raw JSON payload for the given environment ID.
	// Implementations must return a sensible default when no data has been
	// saved for that ID yet.
	GetEnvironment(ctx context.Context, id string) (json.RawMessage, error)

	// SaveEnvironment atomically persists data for the given environment ID.
	SaveEnvironment(ctx context.Context, id string, data json.RawMessage) error
}

// ──────────────────────────────────────────────────────────────────────────────
// RequestStore
// ──────────────────────────────────────────────────────────────────────────────

// RequestStore manages individual HTTP request items within a collection.
//
// Requests are stored inside environment documents (EnvironmentStore).  This
// interface exposes granular CRUD without callers needing to load entire
// environment files.
type RequestStore interface {
	// GetRequest retrieves a single request by its unique ID.
	GetRequest(ctx context.Context, id string) (*Request, error)

	// CreateRequest persists a new request under the given environment and
	// collection. If req.ID is empty the implementation must assign one.
	CreateRequest(ctx context.Context, environmentID, collectionID string, req *Request) error

	// UpdateRequest applies a partial update to an existing request.
	// Only non-nil fields in patch are applied.
	UpdateRequest(ctx context.Context, id string, patch RequestPatch) error

	// DeleteRequest permanently removes a request by ID.
	DeleteRequest(ctx context.Context, id string) error
}

// ──────────────────────────────────────────────────────────────────────────────
// TreeStore
// ──────────────────────────────────────────────────────────────────────────────

// TreeNode is a single node in the collection navigation tree.
//
// Type is either:
//   - "folder"     – a collection node; has Name and Children.
//   - "requestRef" – a lightweight request reference; carries only the ID.
//     Full request details are fetched separately via RequestStore.GetRequest.
type TreeNode struct {
	ID       string     `json:"id"`
	Type     string     `json:"type"`               // "folder" | "requestRef"
	Name     string     `json:"name,omitempty"`     // folder only
	Children []TreeNode `json:"children,omitempty"` // folder only
}

// CollectionTree is the lightweight navigation tree for one environment.
// It contains no request definitions – only the folder hierarchy and request IDs.
type CollectionTree struct {
	// Children are the top-level folder nodes inside the environment.
	// Always serialised as an array (never null).
	Children []TreeNode `json:"children"`
}

// TreeStore manages the collection navigation tree for an environment,
// independently of the full request payloads stored inside it.
//
// Separating tree layout from request content lets the frontend load the
// navigation sidebar quickly without fetching KB-sized request definitions,
// and prepares the architecture for future request-per-file storage.
type TreeStore interface {
	// GetTree returns the navigation tree for the given environment ID.
	// Only folder structure and request IDs are returned; no request body or
	// authentication details are included.
	GetTree(ctx context.Context, envID string) (*CollectionTree, error)

	// SaveTree replaces the collection navigation structure for the given
	// environment, preserving full request data for every requestRef that
	// still appears in the new tree. References to unknown request IDs are
	// rejected with ErrNotFound (wrapped).
	SaveTree(ctx context.Context, envID string, tree *CollectionTree) error
}

// ──────────────────────────────────────────────────────────────────────────────
// HistoryStore
// ──────────────────────────────────────────────────────────────────────────────

// HistoryEntry is the lightweight metadata record for one execution of a saved
// request. It is stored separately from the full response payload so that the
// history list endpoint can be served without reading large response bodies.
type HistoryEntry struct {
	ID           string    `json:"id"`
	RequestID    string    `json:"requestId"`
	Timestamp    time.Time `json:"timestamp"`
	Status       int       `json:"status"`
	DurationMs   int64     `json:"durationMs"`
	ResponseSize int64     `json:"responseSize"`
}

// HistoryResponse is the full response payload for one historical execution.
// It is loaded lazily – only when the client explicitly requests it – to keep
// history list calls fast even when bodies are large.
type HistoryResponse struct {
	HistoryID  string            `json:"historyId"`
	RequestID  string            `json:"requestId"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
}

// HistoryPage is the cursor-paginated result for a history list request.
//
// Cursor semantics: NextCursor is the opaque cursor to pass as the ?cursor=
// query parameter to retrieve the next page. An empty NextCursor means there
// are no further pages.
type HistoryPage struct {
	Items      []HistoryEntry `json:"items"`
	NextCursor string         `json:"nextCursor,omitempty"`
}

// HistoryStore manages execution history for saved requests.
//
// History metadata (HistoryEntry) is stored independently from response
// payloads (HistoryResponse) so that list operations remain fast regardless
// of response body size.
type HistoryStore interface {
	// ListHistory returns a page of history entries for the given request,
	// ordered newest-first. limit caps the number of entries returned (1–100);
	// cursor is the opaque value from a previous HistoryPage.NextCursor.
	// An empty cursor starts from the most recent entry.
	ListHistory(ctx context.Context, requestID string, limit int, cursor string) (*HistoryPage, error)

	// AddHistory records a new execution. If entry.ID or entry.Timestamp are
	// zero-valued the implementation must assign them. The response payload is
	// stored separately from the metadata.
	AddHistory(ctx context.Context, entry *HistoryEntry, response *HistoryResponse) error

	// GetHistoryResponse retrieves the full response payload for one history
	// entry. Returns ErrNotFound if the entry or its response does not exist.
	GetHistoryResponse(ctx context.Context, requestID, historyID string) (*HistoryResponse, error)
}

// ──────────────────────────────────────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────────────────────────────────────

// KeyValue is a named, enabled key-value pair used for request params, headers,
// and body form rows.
type KeyValue struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Value   string `json:"value"`
	Enabled bool   `json:"enabled"`
}

// AuthBasic holds HTTP Basic authentication credentials.
type AuthBasic struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// AuthBearer holds Bearer token authentication configuration.
type AuthBearer struct {
	Token string `json:"token"`
}

// AuthOAuth2 holds OAuth 2.0 authentication configuration.
type AuthOAuth2 struct {
	GrantType      string `json:"grantType"`
	ClientID       string `json:"clientId"`
	ClientSecret   string `json:"clientSecret"`
	AccessTokenURL string `json:"accessTokenUrl"`
	AuthURL        string `json:"authUrl"`
	Scope          string `json:"scope"`
	Token          string `json:"token"`
}

// AuthAwsIam holds AWS IAM authentication configuration.
type AuthAwsIam struct {
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	Region          string `json:"region"`
	Service         string `json:"service"`
	SessionToken    string `json:"sessionToken"`
}

// Request represents a full HTTP request item stored within a collection.
type Request struct {
	ID     string `json:"id"`
	Type   string `json:"type"` // always "request"
	Name   string `json:"name"`
	Method string `json:"method"`
	URL    string `json:"url"`

	// Body
	BodyType     string     `json:"bodyType,omitempty"`
	BodyFormRows []KeyValue `json:"bodyFormRows,omitempty"`
	BodyText     string     `json:"bodyText,omitempty"`
	BodyFilePath string     `json:"bodyFilePath,omitempty"`

	// Query params and request headers
	Params  []KeyValue `json:"params,omitempty"`
	Headers []KeyValue `json:"headers,omitempty"`

	// Authentication
	AuthEnabled bool        `json:"authEnabled,omitempty"`
	AuthType    string      `json:"authType,omitempty"`
	AuthBasic   *AuthBasic  `json:"authBasic,omitempty"`
	AuthBearer  *AuthBearer `json:"authBearer,omitempty"`
	AuthOAuth2  *AuthOAuth2 `json:"authOAuth2,omitempty"`
	AuthAwsIam  *AuthAwsIam `json:"authAwsIam,omitempty"`

	// Pre/post scripts
	PreRequestScript    string `json:"preRequestScript,omitempty"`
	AfterResponseScript string `json:"afterResponseScript,omitempty"`
}

// RequestPatch carries the fields for a partial update on an existing request.
//
// Pointer fields: nil means "leave unchanged", non-nil means "update to this value".
// Slice fields: nil means "leave unchanged", non-nil (even empty) means "replace".
type RequestPatch struct {
	Name   *string `json:"name,omitempty"`
	Method *string `json:"method,omitempty"`
	URL    *string `json:"url,omitempty"`

	// Body
	BodyType     *string    `json:"bodyType,omitempty"`
	BodyFormRows []KeyValue `json:"bodyFormRows"` // no omitempty: distinguishes nil from []
	BodyText     *string    `json:"bodyText,omitempty"`
	BodyFilePath *string    `json:"bodyFilePath,omitempty"`

	// Query params and headers
	Params  []KeyValue `json:"params"`  // no omitempty: distinguishes nil from []
	Headers []KeyValue `json:"headers"` // no omitempty: distinguishes nil from []

	// Authentication
	AuthEnabled *bool       `json:"authEnabled,omitempty"`
	AuthType    *string     `json:"authType,omitempty"`
	AuthBasic   *AuthBasic  `json:"authBasic,omitempty"`
	AuthBearer  *AuthBearer `json:"authBearer,omitempty"`
	AuthOAuth2  *AuthOAuth2 `json:"authOAuth2,omitempty"`
	AuthAwsIam  *AuthAwsIam `json:"authAwsIam,omitempty"`

	// Scripts
	PreRequestScript    *string `json:"preRequestScript,omitempty"`
	AfterResponseScript *string `json:"afterResponseScript,omitempty"`
}

// CollectionMeta is a lightweight descriptor used when listing collections
// without loading the full collection document.
type CollectionMeta struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
