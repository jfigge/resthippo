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
MOCK_DIR        ?= $(WORKSPACE)/mock
MOCK_PID        ?= $(MOCK_DIR)/.mock.pid
MOCK_PORT       ?= 8888

# -----------------------------------------------------------------------------
# Keycloak Configuration
# -----------------------------------------------------------------------------
SHELL := /bin/bash

KEYCLOAK_IMAGE ?= quay.io/keycloak/keycloak:26.2
CONTAINER_NAME ?= keycloak-dev
KEYCLOAK_PORT ?= 8090
KEYCLOAK_REALM ?= demo-realm

KEYCLOAK_ADMIN ?= admin
KEYCLOAK_ADMIN_PASSWORD ?= admin123

USER1 ?= alice
USER1_PASSWORD ?= alice123

USER2 ?= bob
USER2_PASSWORD ?= bob123

CLIENT_SECRET ?= super-secret-client-value

KC := docker exec $(CONTAINER_NAME) /opt/keycloak/bin/kcadm.sh
KC_SERVER := http://localhost:8080

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
	@cd $(SRC_DIR) && npx prettier --write \
		"web/**/*.{js,css,html}" \
		"app/**/*.js" > /dev/null
	@echo "--------------------------------"

# ─── Linting ──────────────────────────────────────────────────────────────────
lint:
	@echo "Linting JavaScript..."
	@cd $(SRC_DIR) && npx eslint \
		"web/scripts/**/*.js" \
		"app/**/*.js" 2>/dev/null
	@echo "--------------------------------"

# ─── Testing ──────────────────────────────────────────────────────────────────
test: test-js test-auth test-oauth

test-js:
	@echo "Running JavaScript store tests..."
	@node --test $(APP_DIR)/store/tests/stores.test.js $(APP_DIR)/store/tests/crypto.test.js $(APP_DIR)/store/tests/integration.test.js $(APP_DIR)/store/tests/migrations.test.js $(APP_DIR)/store/tests/io-locking.test.js $(APP_DIR)/store/tests/backup.test.js
	@echo "--------------------------------"

test-auth:
	@echo "Running main-process auth tests..."
	@node --test $(APP_DIR)/auth/tests/digest.test.js $(APP_DIR)/auth/tests/ntlm.test.js
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
	@echo "Available targets for mock server"
	@echo "    mock-up       Build and start mock server on :8888"
	@echo "    mock-down     Stop mock server"
	@echo "    mock-build    Build mock server binary"
	@echo ""
	@echo "Available targets for keycloak"
	@echo "    start         Start Keycloak in dev mode"
	@echo "    wait          Wait until Keycloak is healthy"
	@echo "    bootstrap     Configure realm, users, and clients"
	@echo "    creds         Print OAuth/OpenID configuration details"
	@echo "    stop          Stop and remove Keycloak container"
	@echo "    reset         Stop container and delete volumes"
	@echo "    kc_all           Start + configure + creds"

# -----------------------------------------------------------------------------
# Start Keycloak
# -----------------------------------------------------------------------------
.PHONY: start
start:
	@echo "Starting Keycloak developer container..."
	@docker run -d \
		--name $(CONTAINER_NAME) \
		-p $(KEYCLOAK_PORT):8080 \
		-e KEYCLOAK_ADMIN=$(KEYCLOAK_ADMIN) \
		-e KEYCLOAK_ADMIN_PASSWORD=$(KEYCLOAK_ADMIN_PASSWORD) \
		$(KEYCLOAK_IMAGE) \
		start-dev >/dev/null
	@echo "Keycloak started at http://localhost:$(KEYCLOAK_PORT)"

# -----------------------------------------------------------------------------
# Wait for readiness
# -----------------------------------------------------------------------------
.PHONY: wait
wait:
	@echo "Waiting for Keycloak to become ready..."
	@until curl -s http://localhost:$(KEYCLOAK_PORT)/realms/master >/dev/null 2>&1; do \
		sleep 3; \
		echo "  still waiting..."; \
	done
	@echo "Keycloak is ready"

# -----------------------------------------------------------------------------
# Bootstrap realm, users, and OAuth clients
# -----------------------------------------------------------------------------
.PHONY: bootstrap
bootstrap: wait
	@echo "Authenticating kcadm..."
	@$(KC) config credentials \
		--server $(KC_SERVER) \
		--realm master \
		--user $(KEYCLOAK_ADMIN) \
		--password $(KEYCLOAK_ADMIN_PASSWORD) >/dev/null

	@echo "Creating realm $(KEYCLOAK_REALM)..."
	@$(KC) create realms -s realm=$(KEYCLOAK_REALM) -s enabled=true >/dev/null || true

	@echo "Creating users..."
	@$(KC) create users -r $(KEYCLOAK_REALM) \
		-s username=$(USER1) \
		-s enabled=true >/dev/null || true

	@$(KC) set-password -r $(KEYCLOAK_REALM) \
		--username $(USER1) \
		--new-password $(USER1_PASSWORD)

	@$(KC) create users -r $(KEYCLOAK_REALM) \
		-s username=$(USER2) \
		-s enabled=true >/dev/null || true

	@$(KC) set-password -r $(KEYCLOAK_REALM) \
		--username $(USER2) \
		--new-password $(USER2_PASSWORD)

	@echo "Creating OAuth Code Flow client..."
	@$(KC) create clients -r $(KEYCLOAK_REALM) \
		-s clientId=oauth-code-client \
		-s enabled=true \
		-s publicClient=false \
		-s secret=$(CLIENT_SECRET) \
		-s standardFlowEnabled=true \
		-s directAccessGrantsEnabled=false \
		-s serviceAccountsEnabled=false \
		-s implicitFlowEnabled=false \
		-s 'redirectUris=["http://localhost:3000/*"]' \
		-s 'webOrigins=["*"]' >/dev/null || true

	@echo "Creating OAuth Code Flow with PKCE client..."
	@$(KC) create clients -r $(KEYCLOAK_REALM) \
		-s clientId=oauth-pkce-client \
		-s enabled=true \
		-s publicClient=true \
		-s standardFlowEnabled=true \
		-s directAccessGrantsEnabled=false \
		-s serviceAccountsEnabled=false \
		-s implicitFlowEnabled=false \
		-s 'attributes."pkce.code.challenge.method"=S256' \
		-s 'redirectUris=["http://localhost:3001/*"]' \
		-s 'webOrigins=["*"]' >/dev/null || true

	@echo "Creating Client Credentials client..."
	@$(KC) create clients -r $(KEYCLOAK_REALM) \
		-s clientId=client-credentials-client \
		-s enabled=true \
		-s publicClient=false \
		-s secret=$(CLIENT_SECRET) \
		-s standardFlowEnabled=false \
		-s directAccessGrantsEnabled=false \
		-s serviceAccountsEnabled=true \
		-s implicitFlowEnabled=false >/dev/null || true

	@echo "Creating Implicit Flow client..."
	@$(KC) create clients -r $(KEYCLOAK_REALM) \
		-s clientId=implicit-client \
		-s enabled=true \
		-s publicClient=true \
		-s standardFlowEnabled=false \
		-s implicitFlowEnabled=true \
		-s directAccessGrantsEnabled=false \
		-s serviceAccountsEnabled=false \
		-s 'redirectUris=["http://localhost:3002/*"]' \
		-s 'webOrigins=["*"]' >/dev/null || true

	@echo "Creating Resource Owner Password Credentials client..."
	@$(KC) create clients -r $(KEYCLOAK_REALM) \
		-s clientId=password-grant-client \
		-s enabled=true \
		-s publicClient=false \
		-s secret=$(CLIENT_SECRET) \
		-s standardFlowEnabled=false \
		-s directAccessGrantsEnabled=true \
		-s serviceAccountsEnabled=false \
		-s implicitFlowEnabled=false >/dev/null || true

	@echo "Bootstrap complete"

# -----------------------------------------------------------------------------
# Print configuration and curl examples
# -----------------------------------------------------------------------------
.PHONY: creds
creds:
	@echo ""
	@echo "============================================================"
	@echo "Keycloak Developer Environment"
	@echo "============================================================"
	@echo ""
	@echo "Server:"
	@echo "  URL: http://localhost:$(KEYCLOAK_PORT)"
	@echo "  Realm: $(KEYCLOAK_REALM)"
	@echo ""
	@echo "Admin Login:"
	@echo "  Username: $(KEYCLOAK_ADMIN)"
	@echo "  Password: $(KEYCLOAK_ADMIN_PASSWORD)"
	@echo ""
	@echo "Test Users:"
	@echo "  $(USER1) / $(USER1_PASSWORD)"
	@echo "  $(USER2) / $(USER2_PASSWORD)"
	@echo ""
	@echo "OpenID Connect Endpoints:"
	@echo "  Authorization Endpoint:"
	@echo "    http://localhost:$(KEYCLOAK_PORT)/realms/$(KEYCLOAK_REALM)/protocol/openid-connect/auth"
	@echo ""
	@echo "  Token Endpoint:"
	@echo "    http://localhost:$(KEYCLOAK_PORT)/realms/$(KEYCLOAK_REALM)/protocol/openid-connect/token"
	@echo ""
	@echo "  JWKS Endpoint:"
	@echo "    http://localhost:$(KEYCLOAK_PORT)/realms/$(KEYCLOAK_REALM)/protocol/openid-connect/certs"
	@echo ""
	@echo "OAuth Code Flow Client"
	@echo "  Client ID: oauth-code-client"
	@echo "  Client Secret: $(CLIENT_SECRET)"
	@echo "  Redirect URI: http://localhost:3000/callback"
	@echo ""
	@echo "OAuth PKCE Client"
	@echo "  Client ID: oauth-pkce-client"
	@echo "  Redirect URI: http://localhost:3001/callback"
	@echo "  PKCE Method: S256"
	@echo ""
	@echo "Client Credentials Client"
	@echo "  Client ID: client-credentials-client"
	@echo "  Client Secret: $(CLIENT_SECRET)"
	@echo ""
	@echo "Implicit Flow Client"
	@echo "  Client ID: implicit-client"
	@echo "  Redirect URI: http://localhost:3002/callback"
	@echo ""
	@echo "Password Grant Client"
	@echo "  Client ID: password-grant-client"
	@echo "  Client Secret: $(CLIENT_SECRET)"
	@echo ""
	@echo "Sample Client Credentials Request:"
	@echo "curl -X POST \
  http://localhost:$(KEYCLOAK_PORT)/realms/$(KEYCLOAK_REALM)/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials' \
  -d 'client_id=client-credentials-client' \
  -d 'client_secret=$(CLIENT_SECRET)'"
	@echo ""
	@echo "Sample Password Grant Request:"
	@echo "curl -X POST \
  http://localhost:$(KEYCLOAK_PORT)/realms/$(KEYCLOAK_REALM)/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=password' \
  -d 'client_id=password-grant-client' \
  -d 'client_secret=$(CLIENT_SECRET)' \
  -d 'username=$(USER1)' \
  -d 'password=$(USER1_PASSWORD)'"
	@echo ""
	@echo "============================================================"

# -----------------------------------------------------------------------------
# Composite target
# -----------------------------------------------------------------------------
.PHONY: kc
kc: start bootstrap creds

# -----------------------------------------------------------------------------
# Stop and remove container
# -----------------------------------------------------------------------------
.PHONY: stop
stop:
	@echo "Stopping and removing container..."
	@docker rm -f $(CONTAINER_NAME) >/dev/null 2>&1 || true
	@echo "Container removed"

# -----------------------------------------------------------------------------
# Full cleanup
# -----------------------------------------------------------------------------
.PHONY: reset
reset: stop
	@echo "Removing Keycloak data volume (if present)..."
	@docker volume rm $(CONTAINER_NAME)-data >/dev/null 2>&1 || true
	@echo "Cleanup complete"

# -----------------------------------------------------------------------------
# Mock server (Go) — MIME type test API on http://localhost:8888
# -----------------------------------------------------------------------------
.PHONY: mock-build mock-up mock-down

mock-build:
	@echo "Building mock server..."
	@cd $(MOCK_DIR) && go build -o mock-server .
	@echo "--------------------------------"

mock-up: mock-build
	@echo "Starting mock server on http://localhost:$(MOCK_PORT)..."
	@$(MOCK_DIR)/mock-server 2>$(MOCK_DIR)/.mock.log & echo $$! > $(MOCK_PID)
	@sleep 0.3
	@echo "  GET http://localhost:$(MOCK_PORT)/mimes"
	@echo "  GET http://localhost:$(MOCK_PORT)/mimes/<type>"
	@echo "  GET http://localhost:$(MOCK_PORT)/status"
	@echo "  GET http://localhost:$(MOCK_PORT)/status/<code>"
	@echo "--------------------------------"

mock-down:
	@if [ -f $(MOCK_PID) ]; then \
		kill $$(cat $(MOCK_PID)) 2>/dev/null; \
		rm -f $(MOCK_PID); \
		echo "Mock server stopped"; \
	else \
		echo "Mock server not running"; \
	fi

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
		mock-up mock-down mock-build \
		start wait bootstrap creds stop reset kc
