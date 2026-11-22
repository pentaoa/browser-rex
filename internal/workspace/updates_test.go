package workspace

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLocalWatchWakesOnMutationAndReleasesOnCancel(t *testing.T) {
	s := New("", Sandbox{})
	s.sessions = []*session{{ID: "test"}}
	server := s.Handler()
	current := s.changesVersion(0)
	watch := func(ctx context.Context) <-chan *httptest.ResponseRecorder {
		out := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			w := httptest.NewRecorder()
			server.ServeHTTP(w, httptest.NewRequest("GET", "/api/updates?since="+current, nil).WithContext(ctx))
			out <- w
		}()
		return out
	}
	waitFor := func(predicate func() bool) {
		t.Helper()
		deadline := time.Now().Add(time.Second)
		for !predicate() {
			if time.Now().After(deadline) {
				t.Fatal("update waiter did not reach the expected state")
			}
			time.Sleep(time.Millisecond)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := watch(ctx)
	waitFor(func() bool { return len(s.changes.waiters) == 1 })
	if _, err := s.mutate(action{Op: "rename", Session: "test", Label: "changed"}); err != nil {
		t.Fatal(err)
	}
	select {
	case w := <-out:
		var result struct{ Version string }
		if err := json.Unmarshal(w.Body.Bytes(), &result); w.Code != 200 || err != nil || result.Version == "" || result.Version == current {
			t.Fatalf("unexpected update: %d %s", w.Code, w.Body.String())
		}
		current = result.Version
	case <-time.After(time.Second):
		t.Fatal("mutation did not wake the watcher")
	}
	out = watch(ctx)
	waitFor(func() bool { return len(s.changes.waiters) == 1 })
	cancel()
	select {
	case <-out:
		if len(s.changes.waiters) != 0 {
			t.Fatal("cancellation leaked a waiter")
		}
	case <-time.After(time.Second):
		t.Fatal("watcher ignored cancellation")
	}
}
