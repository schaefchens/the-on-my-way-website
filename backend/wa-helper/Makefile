# wa-helper build helpers. All Go caches stay inside the repo's .cache/ (git-ignored).
# Pure Go (CGO_ENABLED=0): the SQLite driver is modernc.org/sqlite.

REPO_ROOT := $(abspath $(CURDIR)/../..)
CACHE     := $(REPO_ROOT)/.cache

export GOPATH     := $(CACHE)/go
export GOMODCACHE := $(CACHE)/go/pkg/mod
export GOCACHE    := $(CACHE)/go-build
export GOTMPDIR   := $(CACHE)/tmp
export TMPDIR     := $(CACHE)/tmp
export GOTOOLCHAIN := local
export GOFLAGS    := -buildvcs=false
export CGO_ENABLED := 0
# Keep Go's telemetry/env files out of the real home directory.
export HOME       := $(CACHE)/home

LDFLAGS := -s -w
BIN     := bin

.PHONY: build vet fmt-check test race golden cross check clean dirs

dirs:
	@mkdir -p $(GOTMPDIR) $(HOME) $(BIN)

# Native build for the machine running make (what WA_HELPER_BIN points at in development).
build: dirs
	go build -trimpath -ldflags '$(LDFLAGS)' -o $(BIN)/wa-helper .

vet: dirs
	go vet ./...

fmt-check: dirs
	@out="$$(gofmt -l .)"; if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi

# Unit tests: local files and SQLite only, no network.
test: dirs
	go test -count=1 ./...

# The race detector needs cgo.
race: dirs
	CGO_ENABLED=1 go test -race -count=1 ./...

# Rewrite testdata/golden (validated by packages/contracts/test/wa-golden.test.ts).
golden: dirs
	go test -count=1 -run TestGolden -update ./...

# Static CGO_ENABLED=0 binaries for the supported targets.
cross: dirs
	GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags '$(LDFLAGS)' -o $(BIN)/wa-helper-darwin-arm64 .
	GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '$(LDFLAGS)' -o $(BIN)/wa-helper-linux-amd64 .
	GOOS=linux GOARCH=arm64 go build -trimpath -ldflags '$(LDFLAGS)' -o $(BIN)/wa-helper-linux-arm64 .

check: fmt-check vet test build cross

clean:
	rm -rf $(BIN)
