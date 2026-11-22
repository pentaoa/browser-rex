package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestHostValidation(t *testing.T) {
	for _, endpoint := range []string{"http://example.com", "https://u:p@example.com", "https://example.com/api", "https://example.com?token=x", "https://example.com#fragment", "file:///tmp/sock", "https://example.com:bad"} {
		h := Host{Label: "test", Endpoint: endpoint}
		if validateHost(&h) == nil {
			t.Errorf("accepted %s", endpoint)
		}
	}
	for _, endpoint := range []string{"https://example.com:443/", "http://127.0.0.1:7297", "http://[::1]:7297", "https://host.example.ts.net"} {
		h := Host{Label: "test", Endpoint: endpoint}
		if err := validateHost(&h); err != nil {
			t.Errorf("rejected %s: %v", endpoint, err)
		}
	}
}

func TestHostPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hosts.json")
	m := &Manager{path: path}
	request := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		m.Hosts(w, httptest.NewRequest("POST", "/api/hosts", strings.NewReader(body)))
		return w
	}
	w := request(`{"op":"save","label":"Example","endpoint":"https://example.com/"}`)
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	var h Host
	json.Unmarshal(w.Body.Bytes(), &h)
	if h.ID == "" {
		t.Fatal("missing ID")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private file: %v %v", info, err)
	}
	data, _ := os.ReadFile(path)
	var saved []Host
	if json.Unmarshal(data, &saved) != nil || len(saved) != 1 || saved[0].Endpoint != "https://example.com" {
		t.Fatalf("invalid persisted hosts: %s", data)
	}
	w = request(`{"op":"save","id":"unknown","label":"Example","endpoint":"https://example.com"}`)
	if w.Code != 404 {
		t.Fatal("updated an unknown host")
	}
	body, _ := json.Marshal(fields{"op": "remove", "id": h.ID})
	if request(string(body)).Code != 200 {
		t.Fatal("remove failed")
	}
	data, _ = os.ReadFile(path)
	if string(bytes.TrimSpace(data)) != "[]" {
		t.Fatalf("remove not persisted: %s", data)
	}
	for _, bad := range []string{`{"op":"save","label":"a","endpoint":"https://example.com","unknown":1}`, `{} {}`} {
		if request(bad).Code != 400 {
			t.Fatal("accepted invalid JSON")
		}
	}
}

func TestControlNegotiationAndNoReplay(t *testing.T) {
	var count atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("forwarded browser identity")
		}
		up := websocket.Upgrader{Subprotocols: []string{"rex.control.v1"}}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		var hello struct {
			Min int `json:"api_min_revision"`
			Max int `json:"api_revision"`
		}
		if ws.ReadJSON(&hello) != nil {
			return
		}
		if hello.Min != 9 || hello.Max != 12 {
			t.Error("wrong negotiation range")
		}
		ws.WriteJSON(fields{"type": "welcome", "api_revision": 9})
		var req struct{ ID, Method string }
		if ws.ReadJSON(&req) != nil {
			return
		}
		count.Add(1)
		ws.WriteJSON(fields{"type": "event", "event": "session_created"})
		ws.WriteJSON(fields{"type": "response", "id": req.ID, "payload": fields{"sessions": []any{}}})
		if ws.ReadJSON(&req) != nil {
			return
		}
		count.Add(1) // Simulate the connection dropping after a mutation was accepted.
	}))
	defer srv.Close()
	c, err := connect(context.Background(), Host{Endpoint: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var list struct{ Sessions []any }
	if err = c.call("session.list", fields{}, &list); err != nil {
		t.Fatal(err)
	}
	if err = c.call("session.create", fields{}, nil); err == nil {
		t.Fatal("accepted missing mutation result")
	}
	if count.Load() != 2 {
		t.Fatalf("mutation retried: %d calls", count.Load())
	}
}

func TestNonceAndFragmentedControl(t *testing.T) {
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		parser := streamParser{marker: []byte("\x1b_rex1;42;")}
		stream := "A\x1b_rex1;99;{\"type\":\"child_exited\"}\x1b\\B\x1b_rex1;42;{\"type\":\"resize\",\"cols\":80}\x1b\\C\x1b_rex1;42;{\"type\":\"child_exited\"}\x1b\\"
		for _, b := range []byte(stream) {
			exited, err := parser.write(ws, []byte{b})
			if err != nil {
				return
			}
			if exited {
				return
			}
		}
	}))
	defer srv.Close()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	var output bytes.Buffer
	exits := 0
	for {
		kind, data, err := ws.ReadMessage()
		if err != nil {
			break
		}
		if kind == websocket.BinaryMessage {
			output.Write(data)
		} else if string(data) == "[\"exit\",null]\n" {
			exits++
		}
	}
	if output.String() != "A\x1b_rex1;99;{\"type\":\"child_exited\"}\x1b\\BC" || exits != 1 {
		t.Fatalf("output=%q exits=%d", output.String(), exits)
	}
}
