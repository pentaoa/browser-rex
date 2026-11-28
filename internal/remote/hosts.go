// Package remote adapts explicitly configured native Rex servers to the web API.
package remote

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"github.com/pentaoa/browser-rex/internal/vt"
)

type Host struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Endpoint string `json:"endpoint"`
}

type Manager struct {
	mu         sync.RWMutex
	path       string
	hosts      []Host
	engine     *vt.Engine
	streams    chan struct{}
	uploads    chan struct{}
	ctx        context.Context
	cancel     context.CancelFunc
	pools      map[string]*hostPool
	epoch      string
	generation atomic.Uint64
}

// EnableUploads is used before serving requests, behind the web auth boundary.
func (m *Manager) EnableUploads() {
	m.uploads = make(chan struct{}, 4)
}

// New uses the caller-owned VT engine for snapshot conversion.
func New(ctx context.Context, path string, engine *vt.Engine) (*Manager, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("-hosts-file must be absolute")
	}
	if engine == nil {
		return nil, errors.New("remote hosts require a VT engine")
	}
	var epoch [8]byte
	if _, err := rand.Read(epoch[:]); err != nil {
		return nil, err
	}
	m := &Manager{path: path, engine: engine, streams: make(chan struct{}, 32), pools: make(map[string]*hostPool), epoch: hex.EncodeToString(epoch[:])}
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 64<<10 {
			return nil, errors.New("hosts file must be a private regular file, at most 64 KiB")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if err = json.Unmarshal(data, &m.hosts); err != nil {
			return nil, err
		}
		if len(m.hosts) > 32 {
			return nil, errors.New("at most 32 remote hosts")
		}
		seen := map[string]bool{}
		for i := range m.hosts {
			h := &m.hosts[i]
			if h.ID == "" || len(h.ID) > 64 || seen[h.ID] {
				return nil, errors.New("invalid or duplicate host ID")
			}
			seen[h.ID] = true
			if err := validateHost(h); err != nil {
				return nil, err
			}
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	m.ctx, m.cancel = context.WithCancel(ctx)
	return m, nil
}

func (m *Manager) Close() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
	}
	pools := m.pools
	m.pools = nil
	m.mu.Unlock()
	for _, p := range pools {
		p.close()
	}
}

func validateHost(h *Host) error {
	if len(h.Endpoint) > 2048 {
		return errors.New("server URL exceeds 2048 bytes")
	}
	h.Label = strings.TrimSpace(h.Label)
	if h.Label == "" || !utf8.ValidString(h.Label) || utf8.RuneCountInString(h.Label) > 128 {
		return errors.New("host name must contain 1–128 characters")
	}
	u, err := url.Parse(strings.TrimSpace(h.Endpoint))
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("enter a server origin without credentials, path or query")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || net.ParseIP(u.Hostname()).IsLoopback())) {
		return errors.New("remote hosts require HTTPS; HTTP is allowed only on loopback")
	}
	if strings.ContainsAny(u.Host, "\\\r\n\t ") {
		return errors.New("invalid server address")
	}
	u.Path = ""
	h.Endpoint = u.String()
	return nil
}

func (m *Manager) host(id string) (Host, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, h := range m.hosts {
		if h.ID == id {
			return h, true
		}
	}
	return Host{}, false
}

func (m *Manager) HasHost(id string) bool {
	_, ok := m.host(id)
	return ok
}

func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
func failure(w http.ResponseWriter, status int, message string) {
	reply(w, status, map[string]any{"message": message})
}

// Hosts is called behind the same authentication, Host and mutation Origin checks
// as the local terminal API. Configuration is server-owned, never localStorage.
func (m *Manager) Hosts(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		if m == nil {
			reply(w, 200, map[string]any{"hosts": []Host{}, "enabled": false})
			return
		}
		m.mu.RLock()
		defer m.mu.RUnlock()
		list := append([]Host{}, m.hosts...)
		reply(w, 200, map[string]any{"hosts": list, "enabled": true})
		return
	}
	if m == nil {
		failure(w, 403, "Host management requires -hosts-file on the server.")
		return
	}
	var input struct {
		Op string `json:"op"`
		Host
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	d.DisallowUnknownFields()
	if d.Decode(&input) != nil || d.Decode(new(any)) != io.EOF {
		failure(w, 400, "invalid host configuration")
		return
	}
	if input.Op == "check" {
		if err := validateHost(&input.Host); err != nil {
			failure(w, 400, err.Error())
			return
		}
		c, err := connect(r.Context(), input.Host)
		if err != nil {
			failure(w, 502, "Cannot connect to Rex: "+err.Error())
			return
		}
		defer c.Close()
		reply(w, 200, map[string]any{"api_revision": c.revision})
		return
	}
	if input.Op != "save" && input.Op != "remove" {
		failure(w, 400, "unknown host operation")
		return
	}
	if input.Op == "save" {
		if err := validateHost(&input.Host); err != nil {
			failure(w, 400, err.Error())
			return
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	next := append([]Host{}, m.hosts...)
	index := -1
	for i, h := range next {
		if h.ID == input.ID {
			index = i
			break
		}
	}
	if input.Op == "remove" {
		if index < 0 {
			failure(w, 404, "host not found")
			return
		}
		next = append(next[:index], next[index+1:]...)
	} else if input.ID != "" {
		if index < 0 {
			failure(w, 404, "host not found")
			return
		}
		next[index] = input.Host
	} else {
		if len(next) >= 32 {
			failure(w, 400, "at most 32 remote hosts")
			return
		}
		var id [12]byte
		if _, err := rand.Read(id[:]); err != nil {
			failure(w, 500, "cannot generate host ID")
			return
		}
		input.ID = hex.EncodeToString(id[:])
		next = append(next, input.Host)
	}
	if err := m.save(next); err != nil {
		failure(w, 500, "cannot persist host configuration")
		return
	}
	m.hosts = next
	for id, p := range m.pools {
		keep := false
		for _, h := range next {
			if h.ID == id && h.Endpoint == p.host.Endpoint {
				keep = true
				break
			}
		}
		if !keep {
			p.cancel()
			delete(m.pools, id)
		}
	}
	reply(w, 200, input.Host)
}

func (m *Manager) save(hosts []Host) error {
	data, err := json.MarshalIndent(hosts, "", "  ")
	if err != nil {
		return err
	}
	if len(data)+1 > 64<<10 {
		return errors.New("host configuration exceeds 64 KiB")
	}
	f, err := os.CreateTemp(filepath.Dir(m.path), ".hosts-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(append(data, '\n')); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), m.path)
}

// Route selects only a stored host and exposes a fixed browser API, never an
// arbitrary URL proxy. Requests without a host retain the local implementation.
func (m *Manager) Route(local http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("host")
		if id == "" {
			local.ServeHTTP(w, r)
			return
		}
		if m == nil {
			failure(w, 404, "remote hosts are disabled")
			return
		}
		h, ok := m.host(id)
		if !ok {
			failure(w, 404, "host not found")
			return
		}
		m.serve(w, r, h)
	})
}
