package vt

import (
	"strings"
	"testing"
)

func TestRemoteExportPolicy(t *testing.T) {
	source := []byte(`<html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="https://evil.example/a"><script>alert(1)</script></head><body onload="alert(1)"><pre>safe</pre><a href="javascript:alert(1)">unsafe link</a></body></html>`)
	result, err := SanitizeHTML(source)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"refresh", "<link", "<script", "onload", "javascript:"} {
		if strings.Contains(string(result), bad) {
			t.Errorf("export retained %q", bad)
		}
	}
	if !strings.Contains(string(result), "Content-Security-Policy") || !strings.Contains(string(result), "<pre>safe</pre>") {
		t.Fatal("lost export policy or content")
	}
}
