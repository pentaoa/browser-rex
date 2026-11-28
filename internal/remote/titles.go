package remote

import (
	"context"
	"encoding/json"
	"time"

	"github.com/pentaoa/browser-rex/internal/vt"
)

const terminalCreator = "com.superlogical.terminal"
const maxCachedTitles = 256

type terminalTitle struct {
	Title    string `json:"title"`
	reported bool
}

func (p *hostPool) readTitle(ctx context.Context, c *control, session, block string) terminalTitle {
	p.mu.Lock()
	if current, ok := p.titles[block]; ok {
		p.mu.Unlock()
		return current
	}
	if len(p.titles) >= maxCachedTitles {
		clear(p.titles)
	}
	p.titles[block] = terminalTitle{}
	p.mu.Unlock()

	var initial terminalTitle
	err := c.callContext(ctx, "block.method", fields{
		"session_id": session, "block_id": block, "method": "title", "args": fields{},
	}, &initial)
	if len(initial.Title) > 4096 {
		initial.Title = ""
	}
	initial.Title = vt.DisplayTitle(initial.Title)
	p.mu.Lock()
	defer p.mu.Unlock()
	// An event delivered while the RPC was in flight takes precedence, even
	// when it cleared the title.
	if current := p.titles[block]; current.reported {
		return current
	}
	if err != nil && ctx.Err() != nil {
		delete(p.titles, block)
		return terminalTitle{}
	}
	p.titles[block] = initial
	return initial
}

func (p *hostPool) titleEvent(raw json.RawMessage) {
	var block struct {
		ID      string `json:"block_id"`
		Creator string `json:"creator_name"`
		Name    string
		Payload terminalTitle
	}
	if json.Unmarshal(raw, &block) != nil || block.Creator != terminalCreator || block.Name != "title_changed" || len(block.Payload.Title) > 4096 {
		return
	}
	block.Payload.Title = vt.DisplayTitle(block.Payload.Title)
	p.mu.Lock()
	current, tracked := p.titles[block.ID]
	if tracked {
		block.Payload.reported = true
		p.titles[block.ID] = block.Payload
	}
	p.mu.Unlock()
	if tracked && current.Title != block.Payload.Title {
		p.signal()
	}
}

func (p *hostPool) addTitles(c *control, session string, view map[string]json.RawMessage) {
	var windows []struct {
		Focused string `json:"focused_block_id"`
		Layers  []struct {
			Blocks []struct {
				ID      string `json:"block_id"`
				Creator string `json:"creator_name"`
			}
		}
	}
	if json.Unmarshal(view["windows"], &windows) != nil {
		return
	}
	// Title lookups are optional. Bound the extra latency even if the server
	// has many tabs or a slow connection.
	ctx, cancel := context.WithTimeout(p.ctx, 2*time.Second)
	defer cancel()
	titles := make(map[string]terminalTitle)
	for _, window := range windows {
		if ctx.Err() != nil {
			break
		}
		for _, layer := range window.Layers {
			for _, block := range layer.Blocks {
				if block.ID == window.Focused && block.Creator == terminalCreator && ctx.Err() == nil {
					titles[block.ID] = p.readTitle(ctx, c, session, block.ID)
				}
			}
		}
	}
	if len(titles) != 0 {
		view["terminal_metadata"], _ = json.Marshal(titles)
	}
}
