# ─────────────────────────────────────────────────────────────────────────────
#  wurl – Web URL REST API Client
#  Electron desktop app (Vanilla JS + Node.js)
# ─────────────────────────────────────────────────────────────────────────────

VERSION         ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT          ?= $(shell git rev-parse --short=7 HEAD 2>/dev/null || echo "unknown")
BRANCH          ?= $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
BUILD_TIME      ?= $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')

# Workspace directories
WORKSPACE       ?= $(realpath $(dir $(realpath $(firstword $(MAKEFILE_LIST)))))
BUILD_DIR       ?= $(WORKSPACE)/build
DIST_DIR        ?= $(WORKSPACE)/dist
DATA_DIR        ?= $(WORKSPACE)/data
SRC_DIR         ?= $(WORKSPACE)/src
WEB_DIR         ?= $(WORKSPACE)/src/web
APP_DIR         ?= $(WORKSPACE)/src/app

# ─── Default ──────────────────────────────────────────────────────────────────
all: clean fmt lint test build
	@echo "Build complete"

# ─── Version / Info ───────────────────────────────────────────────────────────
version:
	@echo "Version: $(VERSION)"

info:
	@echo "Build Information:"
	@echo "  Version:    $(VERSION)"
	@echo "  Branch:     $(BRANCH)"
	@echo "  Commit:     $(COMMIT)"
	@echo "  Build Time: $(BUILD_TIME)"

# ─── Formatting ───────────────────────────────────────────────────────────────
fmt:
	@echo "Formatting JavaScript / CSS / HTML..."
#	@npx prettier --write \
#		"$(WEB_DIR)/**/*.{js,css,html}" \
#		"$(APP_DIR)/**/*.js" > /dev/null || true
	@echo "--------------------------------"

# ─── Linting ──────────────────────────────────────────────────────────────────
lint:
	@echo "Linting JavaScript..."
	@npx eslint \
		"$(WEB_DIR)/scripts/**/*.js" \
		"$(APP_DIR)/**/*.js" 2>/dev/null || true
	@echo "--------------------------------"

# ─── Testing ──────────────────────────────────────────────────────────────────
test: test-js test-oauth

test-js:
	@echo "Running JavaScript store tests..."
	@node --test $(APP_DIR)/store/tests/stores.test.js
	@echo "--------------------------------"

test-oauth:
	@echo "Running OAuth 2.0 unit tests..."
	@node --experimental-vm-modules $(WEB_DIR)/scripts/auth/tests/oauth.test.js
	@echo "--------------------------------"

# ─── Development ──────────────────────────────────────────────────────────────
debug:
	@echo "Starting Electron in debug mode (hot-reload)..."
	@cd $(SRC_DIR) && npx electron app/main.js --hot-reload --user-data-dir=$(DATA_DIR)
	@echo "--------------------------------"

# ─── Build ────────────────────────────────────────────────────────────────────
build: build-mac # build-linux build-win

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
	@echo "Preparing build directory..."
	@rm -rf ${BUILD_DIR}/src || true
	@mkdir -p $(BUILD_DIR)/src
	@echo "COMMIT=$(COMMIT)" > ${BUILD_DIR}/src/REVISION_INFO.txt
	@echo "BRANCH=$(BRANCH)" >> ${BUILD_DIR}/src/REVISION_INFO.txt
	@echo "VERSION=$(VERSION)" >> ${BUILD_DIR}/src/REVISION_INFO.txt
	@rsync -a --exclude=node_modules $(SRC_DIR)/ $(BUILD_DIR)/src/

build-install:
	@echo "Installing Node.js dependencies..."
	@cd ${BUILD_DIR}/src; npm install > /dev/null
	@echo "--------------------------------"

vendor-yaml:
	@echo "Bundling yaml vendor file..."
	@cd $(SRC_DIR); npm run vendor-yaml
	@echo "--------------------------------"

vendor-prism:
	@echo "Bundling Prism.js vendor file..."
	@cd $(SRC_DIR); npm run vendor-prism
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

# ─── Launch ───────────────────────────────────────────────────────────────────
launch: all
	@open build/src/dist/mac-arm64/wurl.app

# ─── Clean ────────────────────────────────────────────────────────────────────
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf $(BUILD_DIR) $(DIST_DIR)
	@echo "--------------------------------"

# ─── Help ─────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  wurl — Web URL REST API Client"
	@echo ""
	@echo "  Targets:"
	@echo "    all           fmt → lint → test → build  (default)"
	@echo "    debug         Run Electron with DevTools + hot-reload"
	@echo "    build         Build Electron app for macOS (dir only)"
	@echo "    build-mac     Build Electron app for macOS (dir only)"
	@echo "    build-linux   Build Electron app for Linux (dir only)"
	@echo "    build-win     Build Electron app for Windows (dir only)"
	@echo "    dist          Build full installers for all platforms"
	@echo "    dist-mac      Build macOS installer"
	@echo "    dist-linux    Build Linux installer"
	@echo "    dist-win      Build Windows installer"
	@echo "    vendor-yaml   Bundle yaml npm pkg → web/scripts/vendor/yaml.js"
	@echo "    vendor-prism  Bundle Prism.js → web/scripts/vendor/prism.js"
	@echo "    fmt           Format JS/CSS/HTML (prettier)"
	@echo "    lint          Lint JS (eslint)"
	@echo "    test          Run all JavaScript + OAuth tests"
	@echo "    test-js       Run JavaScript store tests only"
	@echo "    test-oauth    Run OAuth 2.0 unit tests only"
	@echo "    clean         Remove build and dist directories"
	@echo "    version       Print version string"
	@echo "    info          Print full build information"
	@echo "    launch        build and launch the mac electron app"
	@echo ""

# ─── Phony ────────────────────────────────────────────────────────────────────
.PHONY: all version info \
        fmt \
        lint \
        test test-js test-oauth \
        debug \
        build build-mac build-linux build-win \
        build-setup build-install \
        dist dist-mac dist-linux dist-win \
        vendor-yaml vendor-prism \
        clean help launch
