package workspace

import (
	"bytes"
	"testing"
)

func TestReplayAfterHistoryWrap(t *testing.T) {
	p := &pane{}
	for i := range 33 {
		p.publish(bytes.Repeat([]byte{byte(i)}, 16<<10))
	}

	a, err := p.attach(0)
	if err != nil {
		t.Fatal(err)
	}
	replay := bytes.Join(a.replay, nil)
	if !a.Reset || a.Offset != 16<<10 || len(replay) != historyBytes {
		t.Fatalf("unexpected replay bounds: reset=%t offset=%d length=%d", a.Reset, a.Offset, len(replay))
	}
	for i, value := range replay {
		if want := byte(i/(16<<10) + 1); value != want {
			t.Fatalf("replay byte %d = %d, want %d", i, value, want)
		}
	}
}

func TestSlowViewerCanResume(t *testing.T) {
	p := &pane{}
	p.publish([]byte("before"))
	first, err := p.attach(-1)
	if err != nil {
		t.Fatal(err)
	}
	for range cap(first.live) + 2 {
		p.publish([]byte("x"))
	}
	if _, err := p.attach(6); err != errPaneAttached {
		t.Fatalf("second viewer: %v", err)
	}
	count := 0
	for data := range first.live {
		count += len(data.output.first) + len(data.output.second)
	}
	p.detach(first)
	second, err := p.attach(6 + int64(count))
	if err != nil {
		t.Fatal(err)
	}
	if second.Reset || string(bytes.Join(second.replay, nil)) != "xx" {
		t.Fatalf("unexpected resume: reset=%t replay=%q", second.Reset, second.replay)
	}
	p.publish([]byte("after"))
	select {
	case data := <-second.live:
		if string(data.output.first)+string(data.output.second) != "after" {
			t.Fatalf("live output = %q", data.output)
		}
	default:
		t.Fatal("missing live output")
	}
}

func TestReplayKeepsUnalignedRangeWhileNewOutputWraps(t *testing.T) {
	p := &pane{}
	data := make([]byte, historyBytes+outputPageSize+7)
	for i := range data {
		data[i] = byte(i % 251)
	}
	for i := 0; i < len(data); i += 3001 {
		p.publish(data[i:min(i+3001, len(data))])
	}
	a, err := p.attach(-1)
	if err != nil || !a.Reset || a.Offset != outputPageSize+7 {
		t.Fatalf("unaligned stream: %+v, %v", a, err)
	}
	for range outputPages + 1 {
		p.publish(make([]byte, outputPageSize))
	}
	if got := bytes.Join(a.replay, nil); !bytes.Equal(got, data[outputPageSize+7:]) {
		t.Fatal("published replay pages were changed after the ring wrapped")
	}
	p.detach(a)
	resume := p.history.end - outputPageSize - 1
	a, err = p.attach(resume)
	if err != nil || a.Reset || a.Offset != resume || len(bytes.Join(a.replay, nil)) != outputPageSize+1 {
		t.Fatalf("retained offset did not resume: offset=%d reset=%t error=%v", a.Offset, a.Reset, err)
	}
}

func TestTerminalModesAcrossOutputBoundaries(t *testing.T) {
	const stream = "text\x1b[?2004h\x1b[?1h\x1b[?1004h\x1b[?2004l\x1b[?1x\x1b[?20\x1b[?2004h\x1b[?1l"
	for width := 1; width <= len(stream); width++ {
		var modes terminalModes
		for i := 0; i < len(stream); i += width {
			modes.update([]byte(stream[i:min(i+width, len(stream))]))
		}
		if modes.cursor || !modes.focus || !modes.paste {
			t.Fatalf("wrong modes with %d-byte reads: %+v", width, modes)
		}
	}
}
