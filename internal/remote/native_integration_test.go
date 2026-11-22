package remote

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pentaoa/browser-rex/internal/vt"
)

// Optional integration against owner-supplied servers. Only sessions created by
// this test are mutated or destroyed; addresses never belong in the repository.
func TestNativeHosts(t *testing.T) {
	path := os.Getenv("REXWEB_TEST_HOSTS")
	if path == "" {
		t.Skip("set REXWEB_TEST_HOSTS to a private hosts file")
	}
	wasm, err := os.ReadFile("../../web/dist/static/js/ghostty-vt.wasm")
	if err != nil {
		t.Fatal(err)
	}
	engine, err := vt.NewEngine(context.Background(), wasm)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	m, err := New(context.Background(), path, engine)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	srv := httptest.NewServer(m.Route(http.NotFoundHandler()))
	defer srv.Close()
	for _, h := range m.hosts {
		t.Run(h.ID, func(t *testing.T) {
			c, err := connect(context.Background(), h)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			// Exercise the shared workspace client and an actual remote layout event.
			watchURL := srv.URL + "/api/updates?" + url.Values{"host": {h.ID}}.Encode()
			response, err := http.Get(watchURL)
			if err != nil {
				t.Fatal(err)
			}
			var version struct{ Version string }
			err = json.NewDecoder(response.Body).Decode(&version)
			response.Body.Close()
			if err != nil || response.StatusCode != 200 || version.Version == "" {
				t.Fatalf("initial event subscription: %v", err)
			}
			var created struct {
				SessionID string `json:"session_id"`
				Windows   []struct {
					Blocks []string `json:"block_ids"`
				} `json:"initial_windows"`
			}
			result, err := c.action(action{Op: "create", Label: "rexweb-integration-test"})
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(result)
			if err = json.Unmarshal(raw, &created); err != nil || created.SessionID == "" {
				t.Fatalf("invalid create: %s %v", raw, err)
			}
			defer func() {
				if err := c.call("session.destroy", fields{"session_id": created.SessionID}, nil); err != nil {
					t.Errorf("cleanup %s: %v", created.SessionID, err)
				}
			}()
			if len(created.Windows) != 1 || len(created.Windows[0].Blocks) != 1 {
				t.Fatal("missing shell")
			}
			block := created.Windows[0].Blocks[0]
			changed, err := http.Get(watchURL + "&since=" + url.QueryEscape(version.Version))
			if err != nil {
				t.Fatal(err)
			}
			var nextVersion struct{ Version string }
			err = json.NewDecoder(changed.Body).Decode(&nextVersion)
			changed.Body.Close()
			if err != nil || nextVersion.Version == version.Version {
				t.Fatalf("remote create did not invalidate workspace: %v", err)
			}
			if err = c.call("session.attach", fields{"session_id": created.SessionID}, nil); err != nil {
				t.Fatal(err)
			}
			if err = c.block(created.SessionID, block, "write", fields{"data": "printf '\\137\\137SNAPSHOT_OK\\137\\137\\n'\n"}, nil); err != nil {
				t.Fatal(err)
			}
			time.Sleep(200 * time.Millisecond)
			q := url.Values{"host": {h.ID}, "session": {created.SessionID}, "block": {block}}
			ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/api/terminal?"+q.Encode(), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer ws.Close()
			ws.SetReadDeadline(time.Now().Add(15 * time.Second))
			var replay strings.Builder
			ready := false
			for !ready {
				kind, data, err := ws.ReadMessage()
				if err != nil {
					t.Fatalf("snapshot: %v; %s", err, replay.String())
				}
				if kind == websocket.BinaryMessage {
					replay.Write(data)
				} else {
					var msg []json.RawMessage
					json.Unmarshal(data, &msg)
					if len(msg) > 0 && string(msg[0]) == `"ready"` {
						ready = true
					}
				}
			}
			if !strings.Contains(replay.String(), "__SNAPSHOT_OK__") {
				t.Fatalf("snapshot missing marker (%d bytes)", replay.Len())
			}
			if err = ws.WriteJSON([]any{"resize", fields{"width": 91, "height": 29}}); err != nil {
				t.Fatal(err)
			}
			if err = ws.WriteJSON([]any{"stdin", "printf '\\137\\137LIVE_OK\\137\\137\\n'; stty size\n"}); err != nil {
				t.Fatal(err)
			}
			var live strings.Builder
			for !strings.Contains(live.String(), "__LIVE_OK__") || !strings.Contains(live.String(), "29 91") {
				kind, data, err := ws.ReadMessage()
				if err != nil {
					t.Fatalf("live stream: %v (%q)", err, live.String())
				}
				if kind == websocket.BinaryMessage {
					live.Write(data)
				}
			}
			ws.Close()
			if err = c.call("session.view", fields{"session_id": created.SessionID}, nil); err != nil {
				t.Fatalf("disconnect lost session: %v", err)
			}
			t.Logf("API %d: snapshot, live output, input, resize and session survival passed", c.revision)
		})
	}
}
