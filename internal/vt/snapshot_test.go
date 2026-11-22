package vt

import (
	"context"
	"os"
	"testing"
)

func TestNativeSnapshotBoundary(t *testing.T) {
	e := testEngine(t)
	s, err := e.NewTerminal(context.Background(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	data, err := os.ReadFile("../workspace/rex_blank.snapshot")
	if err != nil {
		t.Fatal(err)
	}
	consumed, err := s.RestoreSnapshot(append(append([]byte{}, data...), []byte("live bytes")...))
	if err != nil || consumed != len(data) {
		t.Fatalf("consumed=%d err=%v", consumed, err)
	}
	if _, err := s.Capture("vt", true, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RestoreSnapshot(data[:len(data)/2]); err == nil {
		t.Fatal("accepted truncated snapshot")
	}
}
