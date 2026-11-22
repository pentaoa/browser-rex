package remote

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/pentaoa/browser-rex/internal/vt"
)

type action struct {
	Op        string  `json:"op"`
	Session   string  `json:"session"`
	Block     string  `json:"block"`
	Window    string  `json:"window"`
	Label     string  `json:"label"`
	Direction string  `json:"direction"`
	Before    string  `json:"before"`
	After     string  `json:"after"`
	Ratio     float64 `json:"ratio"`
}

func (c *control) action(a action) (any, error) {
	shell := fields{"block": fields{"flavor": "com.superlogical.terminal.shell"}}
	p := fields{"session_id": a.Session}
	method := ""
	switch a.Op {
	case "create":
		method = "session.create"
		p = fields{"label": a.Label, "initial_windows": []any{fields{"window_label": "Terminal", "layout": shell}}}
	case "rename":
		method = "session.set_label"
		p["label"] = a.Label
	case "destroy":
		method = "session.destroy"
	case "new-window":
		method = "session.new_window"
		p["window_label"] = "Terminal"
		p["layout"] = shell
		p["focus"] = true
	case "focus-window":
		method = "session.focus_window"
		p["window_id"] = a.Window
	case "close-window":
		method = "session.close_window"
		p["window_id"] = a.Window
	case "rename-window":
		method = "session.set_window_label"
		p["window_id"] = a.Window
		p["label"] = a.Label
	case "focus-block":
		method = "session.focus_block"
		p["block_id"] = a.Block
	case "close-block":
		method = "block.close"
		p["block_id"] = a.Block
	case "split":
		method = "session.new_split"
		p["anchor_id"] = a.Block
		p["direction"] = a.Direction
		p["side"] = "after"
		p["ratio"] = .5
		p["layout"] = shell
		p["focus"] = true
	case "resize-split":
		method = "session.resize_pane"
		p["before_block_id"] = a.Before
		p["after_block_id"] = a.After
		p["direction"] = a.Direction
		p["ratio"] = a.Ratio
	default:
		return nil, errors.New("unsupported remote action")
	}
	var result any
	err := c.call(method, p, &result)
	return result, err
}

func (c *control) capture(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	format := q.Get("format")
	if format == "" {
		format = "text"
	}
	if format != "text" && format != "html" && format != "vt" {
		return errors.New("invalid capture format")
	}
	session, block := q.Get("session"), q.Get("block")
	var chunk struct {
		Content string
		ID      uint64
		Total   int
		EOF     bool
	}
	err := c.block(session, block, "format", fields{"format": format, "trim": q.Get("trim") == "true", "unwrap": q.Get("unwrap") == "true", "max_bytes": 65536}, &chunk)
	if err != nil {
		return err
	}
	data := []byte(chunk.Content)
	if chunk.Total > vt.MaxCapture || len(data) > vt.MaxCapture {
		return vt.ErrCaptureLimit
	}
	if chunk.ID != 0 && !chunk.EOF {
		for {
			var part struct {
				Data  string
				Total int
				EOF   bool
			}
			if err := c.block(session, block, "blob_read", fields{"id": chunk.ID, "offset": len(data), "max_bytes": 65536}, &part); err != nil {
				return err
			}
			if part.Total > vt.MaxCapture || len(data)+len(part.Data) > vt.MaxCapture {
				return vt.ErrCaptureLimit
			}
			if len(part.Data) == 0 && !part.EOF {
				return errors.New("empty capture continuation")
			}
			data = append(data, part.Data...)
			if part.EOF {
				break
			}
		}
	}
	if format == "html" {
		data, err = vt.SanitizeHTML(data)
		if err != nil {
			return err
		}
	}
	w.Header().Set("Content-Type", map[string]string{"text": "text/plain; charset=utf-8", "html": "text/html; charset=utf-8", "vt": "application/octet-stream"}[format])
	w.Header().Set("Content-Disposition", "attachment; filename=terminal."+map[string]string{"text": "txt", "html": "html", "vt": "vt"}[format])
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, err = w.Write(data)
	return err
}
