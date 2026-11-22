package vt

import (
	"bytes"
	"context"
	"testing"
)

func BenchmarkNewTerminal(b *testing.B) {
	engine := testEngine(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		state, err := engine.NewTerminal(context.Background(), 80, 24)
		if err != nil {
			b.Fatal(err)
		}
		state.Close()
	}
}

func BenchmarkFeed(b *testing.B) {
	engine := testEngine(b)
	state, err := engine.NewTerminal(context.Background(), 80, 24)
	if err != nil {
		b.Fatal(err)
	}
	defer state.Close()
	for _, test := range []struct {
		name string
		data []byte
	}{
		{"interactive", []byte("\r\x1b[2K\x1b[32mshell\x1b[0m $ echo ready")},
		{"bulk", bytes.Repeat([]byte("\x1b[32moutput\x1b[0m\r\n"), 256)},
	} {
		b.Run(test.name, func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(test.data)))
			for i := 0; i < b.N; i++ {
				if _, err := state.Feed(test.data); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
