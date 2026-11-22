package remote

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type mockRex struct {
	mu               sync.Mutex
	connections      map[*websocket.Conn]bool
	dials, mutations atomic.Int32
	drop             atomic.Bool
}

func mockManager(t *testing.T) (*Manager, *mockRex) {
	t.Helper()
	mock := &mockRex{connections: make(map[*websocket.Conn]bool)}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{Subprotocols: []string{"rex.control.v1"}}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		mock.dials.Add(1)
		mock.mu.Lock()
		mock.connections[ws] = true
		mock.mu.Unlock()
		defer func() { mock.mu.Lock(); delete(mock.connections, ws); mock.mu.Unlock(); ws.Close() }()
		var hello any
		if ws.ReadJSON(&hello) != nil {
			return
		}
		mock.mu.Lock()
		ws.WriteJSON(fields{"type": "welcome", "api_revision": 9})
		mock.mu.Unlock()
		for {
			var req struct{ ID, Method string }
			if ws.ReadJSON(&req) != nil {
				return
			}
			if req.Method == "session.create" {
				mock.mutations.Add(1)
				if mock.drop.Load() {
					return
				}
			}
			payload := fields{}
			if req.Method == "session.attach_all" || req.Method == "session.list" {
				payload["sessions"] = []any{}
			}
			mock.mu.Lock()
			err := ws.WriteJSON(fields{"type": "response", "id": req.ID, "payload": payload})
			mock.mu.Unlock()
			if err != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{ctx: ctx, cancel: cancel, epoch: "test", hosts: []Host{{ID: "test", Endpoint: server.URL}}, pools: make(map[string]*hostPool)}
	t.Cleanup(m.Close)
	return m, mock
}

func (mock *mockRex) emit(kind string) {
	mock.mu.Lock()
	defer mock.mu.Unlock()
	for ws := range mock.connections {
		ws.WriteJSON(fields{"type": "event", "payload": fields{"type": "session_event", "payload": fields{"session_id": "test-session", "event": fields{"type": kind}}}})
	}
}

func TestPoolReusesConnectionAcrossCanceledRequests(t *testing.T) {
	m, mock := mockManager(t)
	for i := 0; i < 8; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		r := httptest.NewRequest("GET", "/api/sessions?host=test", nil).WithContext(ctx)
		w := httptest.NewRecorder()
		m.Route(http.NotFoundHandler()).ServeHTTP(w, r)
		cancel()
		if w.Code != 200 {
			t.Fatalf("request %d: %s", i, w.Body.String())
		}
	}
	if got := mock.dials.Load(); got != 1 {
		t.Fatalf("8 independent requests made %d native connections", got)
	}
}

func TestPoolDoesNotReplayAmbiguousMutation(t *testing.T) {
	m, mock := mockManager(t)
	mock.drop.Store(true)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/action?host=test", strings.NewReader(`{"op":"create","label":"test"}`))
	m.Route(http.NotFoundHandler()).ServeHTTP(w, r)
	if w.Code != 502 || mock.mutations.Load() != 1 || mock.dials.Load() != 1 {
		t.Fatalf("mutation retried: status=%d mutations=%d dials=%d", w.Code, mock.mutations.Load(), mock.dials.Load())
	}
	w = httptest.NewRecorder()
	m.Route(http.NotFoundHandler()).ServeHTTP(w, httptest.NewRequest("GET", "/api/sessions?host=test", nil))
	if w.Code != 200 || mock.dials.Load() != 2 || mock.mutations.Load() != 1 {
		t.Fatal("independent read did not recover, or replayed the mutation")
	}
}

func TestWatchCoalescesStructuralEventsAndCancels(t *testing.T) {
	m, mock := mockManager(t)
	p, err := m.pool(m.hosts[0])
	if err != nil {
		t.Fatal(err)
	}
	c, release, err := p.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	release()
	p.mu.Lock()
	before := p.version
	p.mu.Unlock()
	done := make(chan *httptest.ResponseRecorder, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		w := httptest.NewRecorder()
		p.watch(w, httptest.NewRequest("GET", "/api/updates?since="+url.QueryEscape(before), nil).WithContext(ctx))
		done <- w
	}()
	mock.emit("block_event")
	select {
	case <-done:
		t.Fatal("terminal event caused a layout refresh")
	case <-time.After(30 * time.Millisecond):
	}
	mock.emit("session_view_changed")
	select {
	case w := <-done:
		var result struct{ Version string }
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Version == before {
			t.Fatalf("missing invalidation: %s", w.Body.String())
		}
	case <-time.After(time.Second):
		t.Fatal("layout event did not wake browser")
	}
	// A canceled wait must release its slot without closing the shared client.
	p.mu.Lock()
	current := p.version
	p.mu.Unlock()
	ctx2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	p.watch(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/updates?since="+url.QueryEscape(current), nil).WithContext(ctx2))
	if len(p.watchers) != 0 {
		t.Fatal("canceled watcher leaked a slot")
	}
	if err := c.call("session.list", fields{}, nil); err != nil {
		t.Fatalf("canceled watcher closed shared connection: %v", err)
	}
}

func TestPoolShutdownClosesWaiters(t *testing.T) {
	m, _ := mockManager(t)
	p, _ := m.pool(m.hosts[0])
	_, release, err := p.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	release()
	p.mu.Lock()
	since := p.version
	p.mu.Unlock()
	done := make(chan struct{})
	go func() {
		p.watch(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/updates?since="+url.QueryEscape(since), nil))
		close(done)
	}()
	m.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown left a blocked watcher")
	}
}

func TestRemovingHostCancelsItsConnections(t *testing.T) {
	m, _ := mockManager(t)
	m.path = filepath.Join(t.TempDir(), "hosts.json")
	p, err := m.pool(m.hosts[0])
	if err != nil {
		t.Fatal(err)
	}
	c, release, err := p.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	release()
	w := httptest.NewRecorder()
	m.Hosts(w, httptest.NewRequest("POST", "/api/hosts", strings.NewReader(`{"op":"remove","id":"test"}`)))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	select {
	case <-p.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("removed host retained its lifetime")
	}
	select {
	case <-c.done:
	case <-time.After(time.Second):
		t.Fatal("removed host retained its control connection")
	}
	if _, err := m.pool(Host{ID: "test"}); err == nil {
		t.Fatal("removed host could be reconnected")
	}
}
