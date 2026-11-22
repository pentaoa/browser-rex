package workspace

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Workspace changes coalesce into a generation. Waiters share one signal
// and do not keep a queue of intermediate layouts or take the Store lock.
type workspaceChanges struct {
	mu      sync.Mutex
	rev     uint64
	changed chan struct{}
	waiters chan struct{}
}

func (c *workspaceChanges) advance() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rev++
	if c.changed != nil {
		close(c.changed)
		c.changed = nil
	}
}

func (c *workspaceChanges) current() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.rev
}

func (s *Store) changesVersion(rev uint64) string {
	return s.hostID + ":" + strconv.FormatUint(rev, 36)
}

func (s *Store) watchUpdates(w http.ResponseWriter, r *http.Request) {
	// An empty or stale cursor receives the current version without waiting.
	c := &s.changes
	c.mu.Lock()
	version := s.changesVersion(c.rev)
	if r.URL.Query().Get("since") != version {
		c.mu.Unlock()
		respond(w, fields{"version": version}, nil)
		return
	}
	select {
	case c.waiters <- struct{}{}:
		defer func() { <-c.waiters }()
	default:
		c.mu.Unlock()
		respond(w, nil, &apiError{http.StatusServiceUnavailable, "too many workspace update requests"})
		return
	}
	if c.changed == nil {
		c.changed = make(chan struct{})
	}
	changed := c.changed
	c.mu.Unlock()

	timeout := time.NewTimer(10 * time.Second)
	defer timeout.Stop()
	select {
	case <-r.Context().Done():
		return
	case <-changed:
	case <-timeout.C:
	}
	respond(w, fields{"version": s.changesVersion(c.current())}, nil)
}
