package fs

// Stores is a factory that wires all filesystem store implementations together.
// All stores share a single paths instance and a single resolver cache,
// so cache invalidations made by one store (e.g. RequestStore.CreateRequest)
// are immediately visible to others (e.g. HistoryStore.AddHistory).
//
// Usage:
//
//	ss := fs.NewStores(dataDir)
//	mux.HandleFunc("/api/collections", handler.Collections(ss.CollectionStore()))
//	mux.HandleFunc("/api/env",          handler.Environment(ss.EnvironmentStore()))
//	...
type Stores struct {
	p *paths
	r *resolver
}

// NewStores creates a Stores factory rooted at dataDir.
// The collections/ subdirectory (and all sub-paths) are created on first write.
func NewStores(dataDir string) *Stores {
	p := newPaths(dataDir)
	return &Stores{p: p, r: newResolver(p)}
}

// CollectionStore returns the manifest store (GET/PUT /api/collections).
func (s *Stores) CollectionStore() *CollectionStore {
	return &CollectionStore{p: s.p}
}

// EnvironmentStore returns the legacy env-blob store (GET/PUT /api/env).
func (s *Stores) EnvironmentStore() *EnvironmentStore {
	return &EnvironmentStore{p: s.p, r: s.r}
}

// RequestStore returns the granular request store.
func (s *Stores) RequestStore() *RequestStore {
	return &RequestStore{p: s.p, r: s.r}
}

// TreeStore returns the lightweight navigation-tree store.
func (s *Stores) TreeStore() *TreeStore {
	return &TreeStore{p: s.p, r: s.r}
}

// HistoryStore returns the history store.
func (s *Stores) HistoryStore() *HistoryStore {
	return &HistoryStore{p: s.p, r: s.r}
}
