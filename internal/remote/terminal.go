package remote

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{HandshakeTimeout: 5 * time.Second, CheckOrigin: func(*http.Request) bool { return true }} // Outer gateway validates Host and Origin.

func send(ws *websocket.Conn, kind string, value any) error {
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return ws.WriteJSON([]any{kind, value})
}
func output(ws *websocket.Conn, data []byte) error {
	for len(data) > 0 {
		n := min(len(data), 65536)
		ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if err := ws.WriteMessage(websocket.BinaryMessage, data[:n]); err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

func (m *Manager) terminal(w http.ResponseWriter, r *http.Request, h Host) {
	select {
	case m.streams <- struct{}{}:
		defer func() { <-m.streams }()
	default:
		failure(w, 503, "remote terminal connection limit reached")
		return
	}
	pool, err := m.pool(h)
	if err != nil {
		failure(w, 404, err.Error())
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	stopParent := context.AfterFunc(pool.ctx, cancel)
	defer stopParent()
	defer cancel()
	// Complete the browser upgrade before remote handshakes, which may span a
	// high-latency VPN. Input remains disabled until the authoritative replay ends.
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	stopBrowser := context.AfterFunc(ctx, func() { ws.Close() })
	defer stopBrowser()
	ws.SetReadLimit(65536)
	fail := func(message string) {
		if len(message) > 120 {
			message = "Remote Rex connection failed"
		}
		ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseInternalServerErr, message), time.Now().Add(time.Second))
	}
	c, err := connect(ctx, h)
	if err != nil {
		fail(err.Error())
		return
	}
	defer c.Close()
	session, block := r.URL.Query().Get("session"), r.URL.Query().Get("block")
	err = c.call("session.attach", fields{"session_id": session}, nil)
	if err == nil {
		err = c.call("session.own_block", fields{"session_id": session, "block_ids": []string{block}, "mode": "take"}, nil)
	}
	var ticket struct{ Ticket string }
	if err == nil {
		err = c.call("data.connect", fields{"session_id": session, "block_id": block, "data_ref_id": "terminal", "subprotocol": "rex.data.terminal.v1"}, &ticket)
	}
	if err != nil {
		fail(err.Error())
		return
	}
	token, err := base64.RawURLEncoding.DecodeString(ticket.Ticket)
	if err != nil || len(token) != 16 {
		fail("invalid Rex data ticket")
		return
	}
	data, err := openSocket(ctx, h, "/api/data", "rex.data.terminal.v1")
	if err != nil {
		fail(err.Error())
		return
	}
	defer data.Close()
	stopData := context.AfterFunc(ctx, func() { data.Close() })
	defer stopData()
	data.SetReadLimit(65536)
	data.SetWriteDeadline(time.Now().Add(5 * time.Second))
	data.SetReadDeadline(time.Now().Add(10 * time.Second))
	err = data.WriteMessage(websocket.BinaryMessage, append([]byte{1}, token...))
	var welcome []byte
	var kind int
	if err == nil {
		kind, welcome, err = data.ReadMessage()
	}
	if err != nil || kind != websocket.BinaryMessage || len(welcome) != 32 || welcome[0] != 0x81 {
		fail("Rex data handshake rejected")
		return
	}
	nonce := binary.LittleEndian.Uint64(welcome[24:])
	if nonce == 0 {
		fail("invalid Rex channel nonce")
		return
	}
	// A fresh upstream attachment always starts from an authoritative snapshot.
	// Never interpret the browser's previous byte offset as a native stream offset.
	if send(ws, "stream", fields{"offset": 0, "reset": true}) != nil {
		return
	}
	marker := []byte("\x1b_rex1;" + strconv.FormatUint(nonce, 10) + ";")
	var pending []byte
	for {
		kind, chunk, err := data.ReadMessage()
		if err != nil || kind != websocket.BinaryMessage {
			fail("Remote snapshot is incomplete or incompatible")
			return
		}
		pending = append(pending, chunk...)
		if len(pending) > 16<<20 {
			fail("Remote snapshot exceeds 16 MiB")
			return
		}
		if !bytes.Contains(pending, marker) {
			continue
		}
		state, err := m.engine.NewTerminal(ctx, 80, 24)
		if err != nil {
			return
		}
		consumed, err := state.RestoreSnapshot(pending)
		if err != nil {
			state.Close()
			continue
		}
		replay, err := state.Capture("vt", false, false)
		state.Close()
		if err != nil {
			fail("Remote snapshot cannot be represented as VT")
			return
		}
		if output(ws, replay) != nil {
			return
		}
		pending = pending[consumed:]
		break
	}
	if send(ws, "ready", nil) != nil {
		return
	}
	data.SetReadDeadline(time.Time{})
	// Each socket has one reader and one writer. Bounded channels apply backpressure
	// rather than dropping output. Closing any side tears down both upstream sockets.
	type frame struct {
		data []byte
		err  error
	}
	frames := make(chan frame, 4)
	stop := make(chan struct{})
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			kind, p, err := data.ReadMessage()
			if err == nil && kind != websocket.BinaryMessage {
				err = errors.New("non-binary terminal stream")
			}
			select {
			case frames <- frame{p, err}:
			case <-stop:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	pongs := make(chan json.RawMessage, 1)
	inputDone := make(chan struct{})
	go func() { defer close(inputDone); c.readInput(ws, session, block, pongs) }()
	defer func() {
		close(stop)
		ws.Close()
		data.Close()
		c.Close()
		<-inputDone
		<-readDone
	}()
	parser := streamParser{marker: marker}
	if exited, err := parser.write(ws, pending); err != nil || exited {
		return
	}
	for {
		select {
		case <-c.done:
			return
		case <-inputDone:
			return
		case value := <-pongs:
			if send(ws, "pong", value) != nil {
				return
			}
		case f := <-frames:
			if len(f.data) > 0 {
				if exited, err := parser.write(ws, f.data); err != nil || exited {
					return
				}
			}
			if f.err != nil {
				return
			}
		}
	}
}

func (c *control) readInput(ws *websocket.Conn, session, block string, pongs chan<- json.RawMessage) {
	for {
		var msg []json.RawMessage
		if ws.ReadJSON(&msg) != nil || len(msg) != 2 {
			return
		}
		var kind string
		if json.Unmarshal(msg[0], &kind) != nil {
			return
		}
		switch kind {
		case "stdin":
			var text string
			if json.Unmarshal(msg[1], &text) != nil {
				return
			}
			if c.block(session, block, "write", fields{"data": text}, nil) != nil {
				return
			}
		case "resize":
			var size struct {
				Width, Height int
				CellWidth     int `json:"cell_width"`
				CellHeight    int `json:"cell_height"`
			}
			if json.Unmarshal(msg[1], &size) != nil || size.Width < 2 || size.Width > 500 || size.Height < 1 || size.Height > 500 || size.CellWidth < 0 || size.CellWidth > 1024 || size.CellHeight < 0 || size.CellHeight > 1024 {
				return
			}
			args := fields{"columns": size.Width, "rows": size.Height}
			if size.CellWidth > 0 && size.CellHeight > 0 {
				args["cell_width_px"] = size.CellWidth
				args["cell_height_px"] = size.CellHeight
			}
			if c.block(session, block, "resize", args, nil) != nil {
				return
			}
		case "ping":
			select {
			case pongs <- msg[1]:
			default:
			}
		default:
			return
		}
	}
}

// Only nonce-authenticated APCs are interpreted. Program-generated lookalikes
// remain terminal data. Both the prefix and terminator may cross message bounds.
type streamParser struct{ marker, pending []byte }

func (p *streamParser) write(ws *websocket.Conn, data []byte) (bool, error) {
	p.pending = append(p.pending, data...)
	for len(p.pending) > 0 {
		start := bytes.Index(p.pending, p.marker)
		if start < 0 {
			n := len(p.pending)
			for keep := min(n, len(p.marker)-1); keep > 0; keep-- {
				if bytes.Equal(p.pending[n-keep:], p.marker[:keep]) {
					n -= keep
					break
				}
			}
			if err := output(ws, p.pending[:n]); err != nil {
				return false, err
			}
			p.pending = append([]byte{}, p.pending[n:]...)
			return false, nil
		}
		if err := output(ws, p.pending[:start]); err != nil {
			return false, err
		}
		p.pending = p.pending[start:]
		end := bytes.Index(p.pending[len(p.marker):], []byte{0x1b, '\\'})
		if end < 0 {
			if len(p.pending) > 65536 {
				return false, errors.New("oversized Rex control sequence")
			}
			return false, nil
		}
		end += len(p.marker)
		var event struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(p.pending[len(p.marker):end], &event); err != nil {
			return false, fmt.Errorf("invalid Rex control sequence")
		}
		p.pending = p.pending[end+2:]
		if event.Type == "child_exited" {
			return true, send(ws, "exit", nil)
		}
	}
	return false, nil
}
