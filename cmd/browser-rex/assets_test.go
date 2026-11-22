package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pentaoa/browser-rex/internal/workspace"
)

func TestStaticCachingBoundary(t *testing.T) {
	assets := fstest.MapFS{
		"index.html":                  {Data: []byte("private entry")},
		"static/workspace.css":        {Data: []byte("body{}")},
		"static/js/chunk-Ab12cd34.js": {Data: []byte("export {}")},
	}
	store := workspace.New("/bin/sh", workspace.Sandbox{})
	defer store.Close()
	o := validOptions()
	o.basePath = "/terminal/"
	o.publicURL = "https://terminal.example"
	handler := webHandler(o, store, assets, "private-test-password")
	read := func(path, validator, host, origin, password string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.Host = host
		r.Header.Set("Origin", origin)
		r.Header.Set("If-None-Match", validator)
		r.SetBasicAuth("rexweb", password)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	get := func(path, validator string) *httptest.ResponseRecorder {
		return read(path, validator, "terminal.example", "https://terminal.example", "private-test-password")
	}
	css := get("/terminal/static/workspace.css", "")
	etag := css.Header().Get("ETag")
	if css.Code != 200 || etag == "" || css.Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("unversioned resource: %d %v", css.Code, css.Header())
	}
	versioned := "/terminal/static/workspace.css?v=" + strings.Trim(etag, `"`)
	for _, path := range []string{versioned, "/terminal/static/js/chunk-Ab12cd34.js"} {
		w := get(path, "")
		if w.Code != 200 || w.Header().Get("Cache-Control") != "private, max-age=31536000, immutable" {
			t.Fatalf("versioned resource %s: %d %v", path, w.Code, w.Header())
		}
	}
	unchanged := get(versioned, etag)
	if unchanged.Code != http.StatusNotModified || unchanged.Body.Len() != 0 {
		t.Fatalf("conditional resource response: %d %s", unchanged.Code, unchanged.Body.String())
	}
	if get("/terminal/static/workspace.css?v=stale", "").Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatal("stale revision was treated as immutable")
	}
	for _, path := range []string{"/terminal/", "/terminal/api/sessions", "/terminal/static/missing.js"} {
		if get(path, "").Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("private response cacheable: %s", path)
		}
	}
	for _, attempt := range []struct{ host, origin, password string }{
		{"terminal.example", "https://terminal.example", "wrong"},
		{"evil.example", "https://terminal.example", "private-test-password"},
		{"terminal.example", "https://evil.example", "private-test-password"},
	} {
		w := read(versioned, etag, attempt.host, attempt.origin, attempt.password)
		if w.Code == 200 || w.Code == 304 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("cache bypassed access check: %d %v", w.Code, w.Header())
		}
	}
}
