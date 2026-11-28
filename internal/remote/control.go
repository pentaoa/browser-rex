package remote

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type fields = map[string]any
type control struct {
	*websocket.Conn
	revision   int
	serial     uint64
	mu         sync.Mutex
	responses  chan response
	done       chan struct{}
	stopCancel func() bool
	onEvent    func(json.RawMessage)
	onClose    func()
}

type response struct {
	Type, ID string
	Payload  json.RawMessage
	Error    *struct{ Code, Message string }
}

// MagicDNS can be available on a node whose system resolver is intentionally
// unchanged. Use Tailscale's local DNS only as a fallback for its own suffix.
func dialContext(ctx context.Context, network, address string) (net.Conn, error) {
	d := net.Dialer{Timeout: 5 * time.Second}
	c, err := d.DialContext(ctx, network, address)
	if err == nil {
		return c, nil
	}
	host, _, splitErr := net.SplitHostPort(address)
	var dns *net.DNSError
	if splitErr != nil || !strings.HasSuffix(strings.ToLower(host), ".ts.net") || !errors.As(err, &dns) {
		return nil, err
	}
	d.Resolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, "udp", "100.100.100.100:53")
	}}
	return d.DialContext(ctx, network, address)
}

func openSocket(ctx context.Context, h Host, path, protocol string) (*websocket.Conn, error) {
	u, err := url.Parse(h.Endpoint)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = path
	d := websocket.Dialer{NetDialContext: dialContext, HandshakeTimeout: 5 * time.Second, Subprotocols: []string{protocol}}
	c, response, err := d.DialContext(ctx, u.String(), nil)
	if response != nil && response.Body != nil {
		response.Body.Close()
	}
	if err != nil {
		return nil, errors.New("server unavailable or WebSocket handshake rejected")
	}
	if c.Subprotocol() != protocol {
		c.Close()
		return nil, errors.New("server did not select the Rex subprotocol")
	}
	c.SetReadLimit(1 << 20)
	return c, nil
}

func connect(ctx context.Context, h Host) (*control, error) {
	return connectControl(ctx, ctx, h, nil, nil)
}

func connectControl(lifetime, dial context.Context, h Host, onEvent func(json.RawMessage), onClose func()) (*control, error) {
	ws, err := openSocket(dial, h, "/api/control", "rex.control.v1")
	if err != nil {
		return nil, err
	}
	c := &control{Conn: ws, onEvent: onEvent, onClose: onClose}
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	err = ws.WriteJSON(fields{"type": "hello", "api_revision": 12, "api_min_revision": 9, "client": fields{"kind": "other", "platform": "web", "name": "rexweb", "version": "dev"}})
	var welcome struct {
		Type     string `json:"type"`
		Revision int    `json:"api_revision"`
	}
	if err == nil {
		err = ws.ReadJSON(&welcome)
	}
	if err != nil || welcome.Type != "welcome" || welcome.Revision < 9 || welcome.Revision > 12 {
		ws.Close()
		return nil, errors.New("Rex API revisions 9–12 required")
	}
	c.revision = welcome.Revision
	ws.SetReadDeadline(time.Time{})
	c.responses = make(chan response, 1)
	c.done = make(chan struct{})
	c.stopCancel = context.AfterFunc(lifetime, func() { ws.Close() })
	go c.read()
	return c, nil
}

func (c *control) read() {
	if c.onClose != nil {
		defer c.onClose()
	}
	defer close(c.done)
	defer close(c.responses)
	defer c.Conn.Close()
	for {
		var msg response
		if c.ReadJSON(&msg) != nil {
			return
		}
		if msg.Type == "event" {
			if c.onEvent != nil {
				c.onEvent(msg.Payload)
			}
			continue
		}
		if msg.Type != "response" {
			return
		}
		select {
		case c.responses <- msg:
		default:
			return
		}
	}
}

func (c *control) Close() error {
	c.stopCancel()
	err := c.Conn.Close()
	<-c.done
	return err
}

// Calls are sequential on a connection. On failure the caller closes it; no
// terminal input or workspace mutation is automatically retried.
func (c *control) call(method string, payload any, out any) error {
	return c.callContext(context.Background(), method, payload, out)
}

func (c *control) callContext(ctx context.Context, method string, payload, out any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.serial++
	id := strconv.FormatUint(c.serial, 10)
	c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := c.WriteJSON(fields{"type": "request", "id": id, "method": method, "payload": payload}); err != nil {
		c.Close()
		return err
	}
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case msg, ok := <-c.responses:
		if !ok {
			c.Close()
			return errors.New("Rex connection interrupted; operation was not retried")
		}
		if msg.Type != "response" || msg.ID != id {
			c.Close()
			return errors.New("unexpected Rex response")
		}
		if msg.Error != nil {
			return fmt.Errorf("Rex %s: %s", msg.Error.Code, msg.Error.Message)
		}
		if out != nil {
			err := json.Unmarshal(msg.Payload, out)
			if err != nil {
				c.Close()
			}
			return err
		}
		return nil
	case <-timer.C:
		c.Close()
		return errors.New("Rex operation timed out; operation was not retried")
	case <-ctx.Done():
		c.Close()
		return ctx.Err()
	}
}

func (c *control) block(session, block, method string, args any, out any) error {
	return c.call("block.method", fields{"session_id": session, "block_id": block, "method": method, "args": args}, out)
}

func (m *Manager) serve(w http.ResponseWriter, r *http.Request, h Host) {
	if r.URL.Path == "/api/capabilities" {
		reply(w, 200, fields{"uploads": false, "remote": true})
		return
	}
	if r.URL.Path == "/api/terminal" {
		m.terminal(w, r, h)
		return
	}
	if r.URL.Path == "/api/upload" {
		failure(w, 400, "remote uploads are not supported")
		return
	}
	p, err := m.pool(h)
	if err != nil {
		failure(w, 404, err.Error())
		return
	}
	if r.URL.Path == "/api/updates" {
		p.watch(w, r)
		return
	}
	c, release, err := p.acquire(r.Context())
	if err != nil {
		failure(w, 502, err.Error())
		return
	}
	defer release()
	var result any
	session := r.URL.Query().Get("session")
	switch r.URL.Path {
	case "/api/sessions":
		err = c.call("session.list", fields{}, &result)
	case "/api/session":
		var attached struct {
			View map[string]json.RawMessage `json:"view"`
		}
		err = c.call("session.attach", fields{"session_id": session}, &attached)
		if err == nil {
			p.addTitles(c, session, attached.View)
		}
		result = attached.View
	case "/api/action":
		var a action
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
		d.DisallowUnknownFields()
		if d.Decode(&a) != nil || d.Decode(new(any)) != io.EOF {
			failure(w, 400, "invalid action")
			return
		}
		if a.Op != "create" {
			err = c.call("session.attach", fields{"session_id": a.Session}, nil)
		}
		if err == nil {
			result, err = c.action(a)
		}
	case "/api/capture":
		err = c.call("session.attach", fields{"session_id": session}, nil)
		if err == nil {
			err = c.capture(w, r)
		}
		if err != nil {
			failure(w, 502, err.Error())
		}
		return
	case "/api/metadata":
		result = fields{}
	default:
		failure(w, 404, "unsupported remote operation")
		return
	}
	if err != nil {
		failure(w, 502, err.Error())
		return
	}
	reply(w, 200, result)
}
