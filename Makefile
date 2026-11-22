.PHONY: install-dev typecheck build build-web build-go test check race smoke browser-smoke input-browser layout-browser loading-browser theme-browser remote-browser cross-browser vt-callbacks release clean
.DEFAULT_GOAL := build

VERSION ?= $(shell cat VERSION)
REVISION ?= $(shell git rev-parse --short=12 HEAD 2>/dev/null || printf unknown)

install-dev:
	go mod download
	cd web && bun install --frozen-lockfile

vt-callbacks:
	bun scripts/build-vt-callbacks.ts

typecheck:
	cd web && bun run typecheck

build: build-go

build-web:
	cd web && bun run build

build-go: build-web
	CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=$(VERSION) -X main.commit=$(REVISION)" -o bin/browser-rex ./cmd/browser-rex

test: build-web
	go test ./...
	cd web && bun test

check: build-web
	go vet ./...
	$(MAKE) test

race: build-web
	go test -race ./...

smoke: build-go
	sh tests/rex-smoke.sh

browser-smoke: build-go
	bun tests/browser-smoke.ts

remote-browser: build-go
	bun tests/remote-browser.ts

input-browser: build-go
	bun tests/input-browser.ts

layout-browser: build-go
	bun tests/layout-browser.ts

loading-browser: build-go
	bun tests/loading-browser.ts

theme-browser: build-go
	bun tests/theme-browser.ts

cross-browser: build-web
	bun tests/cross-browser-checks.ts

release: build-web
	sh scripts/release.sh "$(VERSION)"
	bun tests/release-smoke.ts

clean:
	rm -rf bin dist web/dist
