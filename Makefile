# ─────────────────────────────────────────────────────────────────────────────
#  wurl – Web URL REST API Client
#  Dual-mode: Go dev server (IDE) + Electron desktop app
# ─────────────────────────────────────────────────────────────────────────────

APP_NAME        ?= wurlapi
VERSION         ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT          ?= $(shell git rev-parse --short=7 HEAD 2>/dev/null || echo "unknown")
BRANCH          ?= $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
BUILD_TIME      ?= $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')

# Workspace directories
WORKSPACE       ?= $(realpath $(dir $(realpath $(firstword $(MAKEFILE_LIST)))))
BUILD_DIR       ?= $(WORKSPACE)/build
DIST_DIR        ?= $(WORKSPACE)/dist
SRC_DIR         ?= $(WORKSPACE)/src
WEB_DIR         ?= $(WORKSPACE)/src/web
APP_DIR         ?= $(WORKSPACE)/src/app
CMD_DIR         ?= $(WORKSPACE)/src/cmd

# Dev server configuration
SERVER_PORT     ?= 8080
DATA_DIR        ?= $(WORKSPACE)/data

# ─── Default ──────────────────────────────────────────────────────────────────
all: clean install fmt lint test build
	@echo "Build complete"

# ─── Version / Info ───────────────────────────────────────────────────────────
version:
	@echo "Version: $(VERSION)"

info:
	@echo "Build Information:"
	@echo "  App:        $(APP_NAME)"
	@echo "  Version:    $(VERSION)"
	@echo "  Branch:     $(BRANCH)"
	@echo "  Commit:     $(COMMIT)"
	@echo "  Build Time: $(BUILD_TIME)"

# ─── Formatting ───────────────────────────────────────────────────────────────
fmt: fmt-js fmt-go-imports fmt-go-src

fmt-js:
	@echo "Formatting JavaScript / CSS / HTML..."
#	@npx prettier --write \
#		"$(WEB_DIR)/**/*.{js,css,html}" \
#		"$(APP_DIR)/**/*.js" > /dev/null || true
	@echo "--------------------------------"

fmt-go-imports:
	@echo Ordering src imports
	@cd ${SRC_DIR}; goimports -local "${LOCAL_PKG}" -l -w .
	@echo "--------------------------------"

fmt-go-src:
	@echo "Formatting Go code..."
	@cd ${SRC_DIR}; gofmt -l -w .
	@echo "--------------------------------"

# ─── Linting ──────────────────────────────────────────────────────────────────
lint: lint-js lint-go

lint-js:
	@echo "Linting JavaScript..."
	@npx eslint \
		"$(WEB_DIR)/scripts/**/*.js" \
		"$(APP_DIR)/**/*.js" 2>/dev/null || true
	@echo "--------------------------------"

lint-go:
	@echo "Linting Go code..."
	@cd ${SRC_DIR}; go tool -modfile=../tools/golangci-lint/go.mod golangci-lint run
	@echo --------------------------------

# ─── Testing ──────────────────────────────────────────────────────────────────
test: test-go test-js

test-go:
	@echo "Running Go tests..."
	@cd ${SRC_DIR}; go test ./...
	@echo "--------------------------------"

test-js:
	@echo "Running JavaScript store tests..."
	@node --test $(APP_DIR)/store/tests/stores.test.js
	@echo "--------------------------------"

# ─── Development ──────────────────────────────────────────────────────────────
dev: dev-server

dev-server:
	@echo "Starting Go dev server → http://localhost:$(SERVER_PORT)"
	@go run $(CMD_DIR)/main.go \
		-port $(SERVER_PORT) \
		-web  $(WEB_DIR) \
		-data $(DATA_DIR)

dev-electron:
	@echo "Starting Electron in development mode..."
	@SERVER_PORT=$(SERVER_PORT) npx electron $(APP_DIR)/main.js --dev

# ─── Build ────────────────────────────────────────────────────────────────────
build: build-server build-electron

build-server: build-setup
	@find ${BUILD_DIR}/src -type f -name '*_test.go' -delete
	@cd ${BUILD_DIR}/src; go mod tidy
	@cd ${BUILD_DIR}/src; GOWORK=off CGO_ENABLED=0 go build \
    		-ldflags "-X '${LOCAL_PKG}/internal/managers.Version=${VERSION}' \
    		-X '${LOCAL_PKG}/internal/managers.GitBranch=${BRANCH}' \
    		-X '${LOCAL_PKG}/internal/managers.GitCommitFull=${FULL_COMMIT_HASH}' \
    		-X '${LOCAL_PKG}/internal/managers.BuildTime=$$(date -u '+%Y-%m-%dT%H:%M:%SZ')'" \
    		-o ../../${APP_NAME} ./cmd
	@echo "--------------------------------"

build-electron: build-mac build-linux build-win
	@rm -rf ${DIST_DIR} || true
	@mkdir -p ${DIST_DIR}
	@mv ${BUILD_DIR}/src/dist/* ${DIST_DIR}/ || true

build-mac: build-setup build-install
	@echo "Building Electron app for macOS..."
	@cd ${BUILD_DIR}/src; npx electron-builder --mac --dir --publish never > /dev/null
	@echo "--------------------------------"

build-linux: build-setup build-install
	@echo "Building Electron app for Linux..."
	@cd ${BUILD_DIR}/src; npx electron-builder --linux --dir --publish never > /dev/null \
   		|| echo "  (Linux cross-compile may require additional setup on non-Linux hosts)"
	@echo "--------------------------------"

build-win: build-setup build-install
	@echo "Building Electron app for Windows..."
	@cd ${BUILD_DIR}/src; npx electron-builder --win --dir --publish never > /dev/null \
		|| echo "  (Windows cross-compile may require Wine on non-Windows hosts)"
	@echo "--------------------------------"

# ─── Dependencies ─────────────────────────────────────────────────────────────
build-setup:
	@echo "Building Go dev server..."
	@rm -rf ${BUILD_DIR}/src || true
	@mkdir -p $(BUILD_DIR)/src
	@echo "COMMIT=${COMMIT}" > ${BUILD_DIR}/src/REVISION_INFO.txt
	@echo "BRANCH=${BRANCH}" >> ${BUILD_DIR}/src/REVISION_INFO.txt
	@echo "FULL_COMMIT_HASH=${FULL_COMMIT_HASH}" >> ${BUILD_DIR}/src/REVISION_INFO.txt
	@rsync -a --exclude=node_modules ${SRC_DIR}/ ${BUILD_DIR}/src/

build-install:
	@echo "Installing Node.js dependencies..."
	@cd ${BUILD_DIR}/src; npm install > /dev/null
	@echo "--------------------------------"

vendor-yaml:
	@echo "Bundling yaml vendor file..."
	@cd ${SRC_DIR}; npm run vendor-yaml
	@echo "--------------------------------"

vendor-prism:
	@echo "Bundling Prism.js vendor file..."
	@cd ${SRC_DIR}; npm run vendor-prism
	@echo "--------------------------------"

# ─── Distribution packages ────────────────────────────────────────────────────
dist:
	@echo "Building full distribution packages..."
	@npx electron-builder --publish never
	@echo "  → $(DIST_DIR)/"
	@echo "--------------------------------"

dist-mac:
	@echo "Building macOS distribution..."
	@npx electron-builder --mac --publish never

dist-linux:
	@echo "Building Linux distribution..."
	@npx electron-builder --linux --publish never

dist-win:
	@echo "Building Windows distribution..."
	@npx electron-builder --win --publish never

# ─── Clean ────────────────────────────────────────────────────────────────────
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf $(BUILD_DIR) $(DIST_DIR)
	@rm wurlapi || true
	@echo "--------------------------------"

# ─── Help ─────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  wurl — Web URL REST API Client"
	@echo ""
	@echo "  Targets:"
	@echo "    all           install → fmt → lint → test → build  (default)"
	@echo "    install       npm install"
	@echo "    dev           Run Go dev server on :$(SERVER_PORT) (IDE mode)"
	@echo "    dev-electron  Run Electron in development mode (requires dev server)"
	@echo "    build         Build Go server binary + all Electron apps"
	@echo "    build-server  Build the Go dev server binary only"
	@echo "    build-mac     Build Electron app for macOS (dir only)"
	@echo "    build-linux   Build Electron app for Linux (dir only)"
	@echo "    build-win     Build Electron app for Windows (dir only)"
	@echo "    dist          Build full installers for all platforms"
	@echo "    dist-mac      Build macOS installer"
	@echo "    dist-linux    Build Linux installer"
	@echo "    dist-win      Build Windows installer"
	@echo "    vendor-yaml   Bundle yaml npm pkg → web/scripts/vendor/yaml.js"
	@echo "    vendor-prism  Bundle Prism.js → web/scripts/vendor/prism.js"
	@echo "    fmt           Format JS/CSS/HTML (prettier) and Go (gofmt)"
	@echo "    lint          Lint JS (eslint) and Go (golangci-lint / go vet)"
	@echo "    test          Run all Go + JavaScript tests"
	@echo "    clean         Remove build and dist directories"
	@echo "    version       Print version string"
	@echo "    info          Print full build information"
	@echo ""

# ─── Phony ────────────────────────────────────────────────────────────────────
.PHONY: all version info \
        install \
        fmt fmt-js fmt-go \
        lint lint-js lint-go \
        test test-go test-js \
        dev dev-server dev-electron \
        build build-server build-electron build-mac build-linux build-win \
        dist dist-mac dist-linux dist-win \
        vendor-yaml \
        vendor-prism \
        clean help

