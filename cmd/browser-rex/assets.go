package main

import (
	"crypto/sha256"
	"fmt"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
)

type assetResponseWriter struct{ http.ResponseWriter }

func (w assetResponseWriter) WriteHeader(status int) {
	if status >= 400 {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Del("ETag")
	}
	w.ResponseWriter.WriteHeader(status)
}

// Only static frontend resources can be cached. This handler remains behind the
// Host, Origin and password checks; HTML, API data and errors stay no-store.
func staticHandler(assets fs.FS) http.Handler {
	etags := make(map[string]string)
	fs.WalkDir(assets, "static", func(path string, entry fs.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			if data, err := fs.ReadFile(assets, path); err == nil {
				etags["/"+path] = fmt.Sprintf(`"%x"`, sha256.Sum256(data))
			}
		}
		return nil
	})
	// Bun gives every generated JS entry/chunk a content-dependent filename.
	versionedJS := regexp.MustCompile(`^/static/js/[a-zA-Z0-9_-]+-[a-zA-Z0-9]{8}\.js$`)
	files := http.FileServer(http.FS(assets))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if etag, ok := etags[r.URL.Path]; ok {
			w.Header().Set("ETag", etag)
			cache := "private, no-cache"
			if r.URL.Query().Get("v") == strings.Trim(etag, `"`) || versionedJS.MatchString(r.URL.Path) {
				cache = "private, max-age=31536000, immutable"
			}
			w.Header().Set("Cache-Control", cache)
		}
		files.ServeHTTP(assetResponseWriter{w}, r)
	})
}
