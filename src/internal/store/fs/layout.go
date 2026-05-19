package fs

import "path/filepath"

// paths centralises every filesystem path computation for the new layout.
// All methods are pure functions with no I/O side effects.
type paths struct {
	dataDir string
}

func newPaths(dataDir string) *paths { return &paths{dataDir: dataDir} }

// collectionsDir is the root of the new layout: <dataDir>/collections/.
func (p *paths) collectionsDir() string {
	return filepath.Join(p.dataDir, "collections")
}

// manifestPath is the global manifest: collections/index.json.
func (p *paths) manifestPath() string {
	return filepath.Join(p.collectionsDir(), "index.json")
}

// collectionDir is the per-collection root: collections/<collID>/.
func (p *paths) collectionDir(collID string) string {
	return filepath.Join(p.collectionsDir(), collID)
}

// metadataPath stores collection-level metadata: collections/<collID>/metadata.json.
func (p *paths) metadataPath(collID string) string {
	return filepath.Join(p.collectionDir(collID), "metadata.json")
}

// treePath stores the lightweight navigation tree: collections/<collID>/tree.json.
func (p *paths) treePath(collID string) string {
	return filepath.Join(p.collectionDir(collID), "tree.json")
}

// requestsDir is the per-collection request directory: collections/<collID>/requests/.
func (p *paths) requestsDir(collID string) string {
	return filepath.Join(p.collectionDir(collID), "requests")
}

// requestPath is one request document: collections/<collID>/requests/<reqID>.json.
func (p *paths) requestPath(collID, reqID string) string {
	return filepath.Join(p.requestsDir(collID), reqID+".json")
}

// historyDir is the per-request history directory: collections/<collID>/history/<reqID>/.
func (p *paths) historyDir(collID, reqID string) string {
	return filepath.Join(p.collectionDir(collID), "history", reqID)
}

// historyEntryPath is one history-metadata document:
// collections/<collID>/history/<reqID>/<histID>.json.
func (p *paths) historyEntryPath(collID, reqID, histID string) string {
	return filepath.Join(p.historyDir(collID, reqID), histID+".json")
}

// responsesDir is the per-request response directory:
// collections/<collID>/responses/<reqID>/.
func (p *paths) responsesDir(collID, reqID string) string {
	return filepath.Join(p.collectionDir(collID), "responses", reqID)
}

// responsePath is one response document:
// collections/<collID>/responses/<reqID>/<histID>.json.
func (p *paths) responsePath(collID, reqID, histID string) string {
	return filepath.Join(p.responsesDir(collID, reqID), histID+".json")
}
