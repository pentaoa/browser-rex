package remote

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A host shares one workspace control connection across browser requests.
// Terminal streams retain their own clients and size ownership. The gate covers
// whole operations; a failed mutation is returned, never replayed on a new client.
type hostPool struct {
	owner    *Manager
	host     Host
	ctx      context.Context
	cancel   context.CancelFunc
	gate     chan struct{}
	control  *control // protected by gate
	mu       sync.Mutex
	changed  chan struct{}
	version  string
	watchers chan struct{}
}

func (m *Manager) pool(h Host) (*hostPool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx == nil || m.ctx.Err() != nil {
		return nil, errors.New("remote manager stopped")
	}
	// Re-check the registration after acquiring the lock, including endpoint edits.
	valid := false
	for _, registered := range m.hosts {
		if registered.ID == h.ID && registered.Endpoint == h.Endpoint {
			valid = true
			break
		}
	}
	if !valid {
		return nil, errors.New("host configuration changed")
	}
	if p := m.pools[h.ID]; p != nil {
		return p, nil
	}
	ctx, cancel := context.WithCancel(m.ctx)
	p := &hostPool{owner: m, host: h, ctx: ctx, cancel: cancel, gate: make(chan struct{}, 1), changed: make(chan struct{}), watchers: make(chan struct{}, 32)}
	p.signal()
	m.pools[h.ID] = p
	return p, nil
}

func (p *hostPool) signal() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.version = p.owner.epoch + "-" + strconv.FormatUint(p.owner.generation.Add(1), 10)
	close(p.changed)
	p.changed = make(chan struct{})
}

func (p *hostPool) event(raw json.RawMessage) {
	var event struct {
		Type    string
		Payload json.RawMessage
	}
	if json.Unmarshal(raw, &event) != nil {
		return
	}
	if event.Type == "session_event" {
		var session struct{ Event struct{ Type string } }
		if json.Unmarshal(event.Payload, &session) != nil {
			return
		}
		event.Type = session.Event.Type
	}
	// Terminal output and client presence do not change the browser layout.
	if strings.HasPrefix(event.Type, "session_") || strings.HasPrefix(event.Type, "window_") || event.Type == "active_window_changed" {
		p.signal()
	}
}

func (p *hostPool) acquire(ctx context.Context) (*control, func(), error) {
	select {
	case p.gate <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	case <-p.ctx.Done():
		return nil, nil, p.ctx.Err()
	}
	release := func() { <-p.gate }
	if err := p.ctx.Err(); err != nil {
		release()
		return nil, nil, err
	}
	if p.control != nil {
		select {
		case <-p.control.done:
			p.control.Close()
			p.control = nil
		default:
		}
	}
	if p.control == nil {
		c, err := connectControl(p.ctx, ctx, p.host, p.event, p.signal)
		if err == nil {
			err = c.callContext(ctx, "session.attach_all", fields{"event_scope": "session"}, nil)
		}
		if err != nil {
			if c != nil {
				c.Close()
			}
			release()
			return nil, nil, err
		}
		p.control = c
		p.signal()
	}
	return p.control, release, nil
}

func (p *hostPool) close() {
	p.cancel()
	p.gate <- struct{}{}
	if p.control != nil {
		p.control.Close()
		p.control = nil
	}
	<-p.gate
}

// Ten-second long polls fit authenticated HTTP gateways with finite request
// budgets. Waiting holds no RPC gate; events are coalesced by generation, never
// queued per client. Canceled/hidden pages immediately release their waiters.
func (p *hostPool) watch(w http.ResponseWriter, r *http.Request) {
	select {
	case p.watchers <- struct{}{}:
		defer func() { <-p.watchers }()
	default:
		failure(w, 429, "too many workspace watchers")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	_, release, err := p.acquire(ctx)
	if err != nil {
		failure(w, 502, err.Error())
		return
	}
	release()
	p.mu.Lock()
	version, changed := p.version, p.changed
	p.mu.Unlock()
	if r.URL.Query().Get("since") == version {
		select {
		case <-changed:
		case <-ctx.Done():
		case <-p.ctx.Done():
		}
		p.mu.Lock()
		version = p.version
		p.mu.Unlock()
	}
	if r.Context().Err() != nil {
		return
	}
	reply(w, 200, fields{"version": version})
}
