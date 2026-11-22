package workspace

const (
	historyBytes   = 512 << 10
	outputPageSize = 16 << 10
	// One extra slot retains the tail of the oldest page when the byte window
	// begins in the middle of a page.
	outputPages = historyBytes/outputPageSize + 1
)

// outputHistory is an append-only log backed by a bounded ring of lazy pages.
// The pane lock guards the index. Readers own capped slices of published bytes
// and can send them after releasing the lock. Published bytes are never edited.
type outputHistory struct {
	pages [outputPages][]byte
	end   int64
}

// An individual PTY read is at most one page and can cross one boundary.
type outputChunk struct {
	first, second []byte
}

func (h *outputHistory) append(data []byte) outputChunk {
	first := h.appendPage(data)
	var second []byte
	if rest := data[len(first):]; len(rest) != 0 {
		second = h.appendPage(rest)
	}
	return outputChunk{first, second}
}

func (h *outputHistory) appendPage(data []byte) []byte {
	index := h.end / outputPageSize % outputPages
	start := int(h.end % outputPageSize)
	if start == 0 {
		h.pages[index] = make([]byte, outputPageSize)
	}
	page := h.pages[index]
	n := copy(page[start:], data)
	h.end += int64(n)
	return page[start : start+n : start+n]
}

func (h *outputHistory) replay(offset int64) (start int64, reset bool, parts [][]byte) {
	oldest := max(0, h.end-historyBytes)
	reset = offset < oldest || offset > h.end
	if reset {
		offset = oldest
	}
	start = offset
	if offset == h.end {
		return
	}
	parts = make([][]byte, 0, (h.end-1)/outputPageSize-offset/outputPageSize+1)
	for offset < h.end {
		page := h.pages[offset/outputPageSize%outputPages]
		pos := int(offset % outputPageSize)
		n := min(int(h.end-offset), outputPageSize-pos)
		parts = append(parts, page[pos:pos+n:pos+n])
		offset += int64(n)
	}
	return
}
