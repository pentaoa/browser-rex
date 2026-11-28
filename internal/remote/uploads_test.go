package remote

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestSendUploadRequiresNativeCompletion(t *testing.T) {
	ticket := make([]byte, 16)
	body := bytes.Repeat([]byte{42}, (64<<10)+19)
	for _, code := range []int{websocket.CloseNormalClosure, websocket.CloseInternalServerErr} {
		observed := make(chan []byte, 1)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			upgrader := websocket.Upgrader{Subprotocols: []string{uploadProtocol}}
			ws, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer ws.Close()
			ws.SetReadDeadline(time.Now().Add(2 * time.Second))
			if kind, data, err := ws.ReadMessage(); err != nil || kind != websocket.BinaryMessage || !bytes.Equal(data, append([]byte{1}, ticket...)) {
				return
			}
			welcome := make([]byte, 32)
			welcome[0] = 0x81
			if ws.WriteMessage(websocket.BinaryMessage, welcome) != nil {
				return
			}
			var received []byte
			for {
				kind, chunk, err := ws.ReadMessage()
				if err != nil || kind != websocket.BinaryMessage || len(chunk) > 64<<10 {
					return
				}
				if len(chunk) == 0 {
					break
				}
				received = append(received, chunk...)
			}
			observed <- received
			ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, ""), time.Now().Add(time.Second))
		}))
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		err := sendUpload(ctx, Host{Endpoint: server.URL}, base64.RawURLEncoding.EncodeToString(ticket), bytes.NewReader(body))
		cancel()
		server.Close()
		if (err == nil) != (code == websocket.CloseNormalClosure) {
			t.Fatalf("close %d: %v", code, err)
		}
		select {
		case received := <-observed:
			if !bytes.Equal(received, body) {
				t.Fatal("remote bytes differed from staged file")
			}
		default:
			t.Fatal("remote did not receive end-of-input")
		}
	}
}
