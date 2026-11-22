package vt

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// RestoreSnapshot imports one bounded native Ghostty snapshot. Bytes after FINISH
// remain unread. Non-ground parser continuations are rejected rather than lost
// when the imported state is subsequently formatted as VT for a browser.
func (s *State) RestoreSnapshot(data []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || len(data) == 0 || len(data) > 16<<20 {
		return 0, errors.New("invalid snapshot size or closed terminal")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for _, name := range []string{"ghostty_snapshot_decoder_new_buf", "ghostty_snapshot_decoder_set", "ghostty_snapshot_decoder_decode", "ghostty_snapshot_decoder_get", "ghostty_snapshot_decoder_free"} {
		fn := s.module.ExportedFunction(name)
		if fn == nil {
			return 0, fmt.Errorf("missing Ghostty snapshot export %s", name)
		}
		s.functions[name] = fn
	}
	ptr, err := s.alloc(ctx, uint32(len(data)))
	if err != nil {
		return 0, err
	}
	defer s.free(ctx, ptr, uint32(len(data)))
	if !s.module.Memory().Write(ptr, data) {
		return 0, errors.New("snapshot memory overflow")
	}
	if err = s.result(ctx, "ghostty_snapshot_decoder_new_buf", 0, uint64(s.scratch), uint64(ptr), uint64(len(data))); err != nil {
		return 0, err
	}
	decoder, err := s.read32(s.scratch)
	if err != nil {
		return 0, err
	}
	defer s.call(ctx, "ghostty_snapshot_decoder_free", uint64(decoder))
	option, err := s.abi.value("GhosttySnapshotDecoderOption", "MAX_CONTINUATION_BYTES")
	if err != nil {
		return 0, err
	}
	s.put32(s.scratch, 0)
	if err = s.result(ctx, "ghostty_snapshot_decoder_set", uint64(decoder), option, uint64(s.scratch)); err != nil {
		return 0, err
	}
	if err = s.result(ctx, "ghostty_snapshot_decoder_decode", uint64(decoder), uint64(s.scratch)); err != nil {
		return 0, fmt.Errorf("decode native snapshot: %w", err)
	}
	terminal, err := s.read32(s.scratch)
	if err != nil || terminal == 0 {
		return 0, errors.New("snapshot returned no terminal")
	}
	// Replacing the handle happens only after a complete, validated decode.
	s.call(ctx, "ghostty_terminal_free", uint64(s.terminal))
	s.terminal = terminal
	key, err := s.abi.value("GhosttySnapshotDecoderData", "SOURCE_OFFSET")
	if err != nil {
		return 0, err
	}
	if err = s.result(ctx, "ghostty_snapshot_decoder_get", uint64(decoder), key, uint64(s.scratch)); err != nil {
		return 0, err
	}
	consumed, err := s.read32(s.scratch)
	if err != nil || consumed == 0 || int(consumed) > len(data) {
		return 0, errors.New("invalid snapshot source offset")
	}
	s.cols, err = s.get32(ctx, "COLS")
	if err != nil {
		return 0, err
	}
	s.rows, err = s.get32(ctx, "ROWS")
	return int(consumed), err
}
