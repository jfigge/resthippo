# ─────────────────────────────────────────────────────────────────────────────
#  Rest Hippo – Web URL REST API Client
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
MOCK_PROXY_PORT ?= 9999
MOCK_SOCKS_PORT ?= 9998

# Proxy auth (opt-in): when either is set, the mock's forward + SOCKS5 proxies
# require these credentials, and the Electron app can read them at runtime via
# its env() variable function — e.g. {{env('MOCK_PROXY_USER')}}.
MOCK_PROXY_USER ?=
MOCK_PROXY_PASS ?=

# Dev-server port the Electron app reads (process.env.SERVER_PORT) when pointed
# at the Go dev server instead of the bundled renderer.
SERVER_PORT     ?=

# ── Shared dev environment ────────────────────────────────────────────────────
# One place to set the values every dev target sees. Copy dev.env.example →
# dev.env (git-ignored) and edit it; `-include` is after the ?= defaults above
# so dev.env wins over them, while a one-off `make VAR=value` still wins over
# dev.env. `export` then hands the SAME values to each target's child process:
# `make debug` (electron) and `make mock-up` (Go server) inherit them directly;
# `launch` forwards them to the packaged .app via `open --env` (see below).
DEV_ENV_VARS := MOCK_PORT MOCK_PROXY_PORT MOCK_SOCKS_PORT \
                MOCK_PROXY_USER MOCK_PROXY_PASS SERVER_PORT
-include $(WORKSPACE)/dev.env
export $(DEV_ENV_VARS)

# ── Release signing environment ───────────────────────────────────────────────
# Credentials for SIGNED installer builds (dist-mac / dist-win). Copy
# release.env.example → release.env (git-ignored) and fill in the values; the
# `-include` + conditional `export` below hand them to electron-builder, which
# reads these names directly. All are optional — absent ⇒ electron-builder emits
# unsigned artifacts and skips notarization (see release.env.example). In CI the
# same names come from repository secrets, not this file.
#
# Export each var only when it is set AND non-empty; otherwise `unexport` it.
# This matters because:
#   * a blanket `export` of an undefined var hands it to electron-builder as an
#     EMPTY string, and an empty CSC_LINK / WIN_CSC_LINK is read as "a cert was
#     provided" → `… not a file` build failure; and
#   * CI sets `CSC_LINK: ${{ secrets.CSC_LINK }}` which is an empty (but present)
#     env var when the secret is unset — Make passes inherited env vars to
#     sub-processes automatically, so `unexport` is what actually strips it.
# Testing `$(value …)` (not `$(…)`) keeps secret contents out of Make expansion.
RELEASE_ENV_VARS := CSC_LINK CSC_KEY_PASSWORD CSC_IDENTITY_AUTO_DISCOVERY \
                    APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID \
                    APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER \
                    WIN_CSC_LINK WIN_CSC_KEY_PASSWORD
-include $(WORKSPACE)/release.env
$(foreach v,$(RELEASE_ENV_VARS),$(if $(strip $(value $(v))),$(eval export $(v)),$(eval unexport $(v))))

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

# ─── Local builds (what you run day-to-day) ───────────────────────────────────
# Quick reference:
#   make            UNSIGNED, un-notarized macOS .dmg                 (fast; local testing)
#   make all        UNSIGNED, un-notarized installers for ALL platforms
#   make sign-dmg   SIGNED + notarized macOS .dmg                     (ready to ship)
#   make sign-all   SIGNED installers for ALL platforms               (Windows signing is
#                   skipped automatically when WIN_CSC_* creds are absent)
# Signed targets read credentials from release.env (see RELEASE_ENV_VARS above).
# NOTE: the all-platform targets build Windows + Linux too, which needs the
# matching host toolchain (e.g. Wine for the Windows nsis target). On a host that
# lacks it, build that platform on its native runner via the dist-* targets / CI.
# The per-platform CI/release entrypoints (build-*, dist-*) live further down.
.DEFAULT_GOAL := dmg

# Neutralize signing for one electron-builder call: strip every credential from
# its environment and disable keychain auto-discovery, so the output is unsigned
# regardless of release.env or inherited CI secrets. Paired per-recipe with
# `-c.mac.notarize=false` to also force notarization off.
UNSIGNED_ENV := env $(foreach v,$(filter-out CSC_IDENTITY_AUTO_DISCOVERY,$(RELEASE_ENV_VARS)),-u $(v)) CSC_IDENTITY_AUTO_DISCOVERY=false

dmg: build-setup build-install
	@echo "Building macOS .dmg (unsigned, un-notarized)…"
	@cd ${BUILD_DIR}/src; $(UNSIGNED_ENV) npx electron-builder --mac dmg --publish never -c.mac.notarize=false
	@echo "  → ${BUILD_DIR}/src/dist/"
	@echo "--------------------------------"

all: build-setup build-install
	@echo "Building ALL platforms (unsigned, un-notarized)…"
	@cd ${BUILD_DIR}/src; $(UNSIGNED_ENV) npx electron-builder --mac dmg --linux --win --publish never -c.mac.notarize=false
	@echo "  → ${BUILD_DIR}/src/dist/"
	@echo "--------------------------------"

sign-dmg: build-setup build-install
	@echo "Building macOS .dmg (signed + notarized — ready to ship)…"
	@cd ${BUILD_DIR}/src; npx electron-builder --mac dmg --publish never
	@$(MAKE) staple-dmg
	@echo "  → ${BUILD_DIR}/src/dist/"
	@echo "--------------------------------"

sign-all: build-setup build-install
	@echo "Building ALL platforms (macOS + Windows signed where creds present)…"
	@cd ${BUILD_DIR}/src; npx electron-builder --mac dmg --linux --win --publish never
	@$(MAKE) staple-dmg
	@echo "  → ${BUILD_DIR}/src/dist/"
	@echo "--------------------------------"

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

fmt-check:
	@echo "Checking formatting (prettier --check)..."
	@cd $(SRC_DIR) && npx prettier --check \
		"web/**/*.{js,css,html}" \
		"app/**/*.js"
	@echo "--------------------------------"

# ─── Linting ──────────────────────────────────────────────────────────────────
lint:
	@echo "Linting JavaScript..."
	@cd $(SRC_DIR) && npx eslint \
		"web/scripts/**/*.js" \
		"app/**/*.js" 2>/dev/null
	@echo "--------------------------------"

# ─── Testing ──────────────────────────────────────────────────────────────────
test: test-js test-cookies test-auth test-net test-content-type test-ipc test-oauth test-export test-components test-import test-data-store test-quick-access test-i18n test-diagnostics test-renderer-components test-renderer-e2e

test-js:
	@echo "Running JavaScript store tests..."
	@node --test $(APP_DIR)/store/tests/stores.test.js $(APP_DIR)/store/tests/crypto.test.js $(APP_DIR)/store/tests/integration.test.js $(APP_DIR)/store/tests/migrations.test.js $(APP_DIR)/store/tests/io-locking.test.js $(APP_DIR)/store/tests/backup.test.js $(APP_DIR)/store/tests/synchronous-writes.test.js
	@echo "--------------------------------"

test-cookies:
	@echo "Running cookie jar / store tests..."
	@node --test $(APP_DIR)/store/tests/cookie-jar.test.js $(APP_DIR)/store/tests/cookie-store.test.js
	@echo "--------------------------------"

test-auth:
	@echo "Running main-process auth tests..."
	@node --test $(APP_DIR)/auth/tests/digest.test.js $(APP_DIR)/auth/tests/ntlm.test.js $(APP_DIR)/auth/tests/oauth1.test.js
	@echo "--------------------------------"

test-net:
	@echo "Running proxy / retry / websocket / timing / sse / http-engine tests..."
	@node --test $(APP_DIR)/net/tests/proxy.test.js $(APP_DIR)/net/tests/retry.test.js $(APP_DIR)/net/tests/websocket.test.js $(APP_DIR)/net/tests/timing.test.js $(APP_DIR)/net/tests/sse.test.js $(APP_DIR)/net/tests/http-engine.test.js
	@echo "--------------------------------"

test-content-type:
	@echo "Running content-type (binary detection) tests..."
	@node --test $(APP_DIR)/tests/http-content-type.test.js
	@echo "--------------------------------"

test-ipc:
	@echo "Running IPC channel handler/preload parity tests..."
	@node --test $(APP_DIR)/tests/ipc-parity.test.js
	@echo "--------------------------------"

test-oauth:
	@echo "Running OAuth 2.0 unit tests..."
	@node --experimental-vm-modules $(WEB_DIR)/scripts/auth/tests/oauth.test.js
	@echo "--------------------------------"

test-export:
	@echo "Running export redaction tests..."
	@node --test $(WEB_DIR)/scripts/export/tests/postman.test.js $(WEB_DIR)/scripts/export/tests/insomnia.test.js $(WEB_DIR)/scripts/export/tests/openapi.test.js $(WEB_DIR)/scripts/export/tests/har.test.js
	@echo "--------------------------------"

test-components:
	@echo "Running renderer component tests (variable resolution, request payload)..."
	@node --test $(WEB_DIR)/scripts/components/tests/variable-resolver.test.js $(WEB_DIR)/scripts/components/tests/request-payload.test.js $(WEB_DIR)/scripts/components/tests/graphql-schema.test.js $(WEB_DIR)/scripts/components/tests/graphql-validate.test.js $(WEB_DIR)/scripts/components/tests/captures.test.js $(WEB_DIR)/scripts/components/tests/tree-model.test.js $(WEB_DIR)/scripts/components/code-gen/tests/code-gen.test.js
	@echo "--------------------------------"

test-import:
	@echo "Running import fixture tests..."
	@node --test $(WEB_DIR)/scripts/import/tests/import.test.js
	@echo "--------------------------------"

test-data-store:
	@echo "Running renderer IPC-bridge integration tests (data-store)..."
	@node --test $(WEB_DIR)/scripts/tests/data-store.test.js
	@echo "--------------------------------"

test-quick-access:
	@echo "Running favorites / recents helper tests (quick-access)..."
	@node --test $(WEB_DIR)/scripts/tests/quick-access.test.js
	@echo "--------------------------------"

test-i18n:
	@echo "Running i18n tests (locale resolver + t()/format + hardcoded-string guard)..."
	@node --test $(APP_DIR)/tests/i18n.test.js $(APP_DIR)/tests/no-hardcoded-native-strings.test.js $(WEB_DIR)/scripts/tests/i18n.test.js $(WEB_DIR)/scripts/tests/no-hardcoded-strings.test.js
	@echo "--------------------------------"

test-diagnostics:
	@echo "Running logger + diagnostics tests..."
	@node --test $(APP_DIR)/tests/logger.test.js $(APP_DIR)/tests/diagnostics.test.js
	@echo "--------------------------------"

test-renderer-components:
	@echo "Running renderer component render tests (editor + viewer + notifications + pill editors, jsdom)..."
	@node --test $(WEB_DIR)/scripts/tests/request-editor.test.js $(WEB_DIR)/scripts/tests/response-viewer.test.js $(WEB_DIR)/scripts/tests/notifications.test.js $(WEB_DIR)/scripts/tests/pill-editors.test.js $(WEB_DIR)/scripts/tests/tree-view.test.js
	@echo "--------------------------------"

test-renderer-e2e:
	@echo "Running renderer request->response E2E tests (jsdom)..."
	@node --test $(WEB_DIR)/scripts/tests/renderer-e2e.test.js
	@echo "--------------------------------"

# ─── Development ──────────────────────────────────────────────────────────────
debug:
	@echo "Starting Electron in debug mode (hot-reload)..."
	@cd $(SRC_DIR) && npx electron app/main.js --hot-reload --user-data-dir=$(DATA_DIR)
	@echo "--------------------------------"

# ─── Build ────────────────────────────────────────────────────────────────────
build: build-mac # build-linux build-win

build-mac: build-setup build-install
	@echo "Building Electron app for macOS (dir, unsigned)..."
	@cd ${BUILD_DIR}/src; $(UNSIGNED_ENV) npx electron-builder --mac --dir --publish never -c.mac.notarize=false > /dev/null
	@echo "--------------------------------"

build-linux: build-setup build-install
	@echo "Building Electron app for Linux (dir, unsigned)..."
	@cd ${BUILD_DIR}/src; $(UNSIGNED_ENV) npx electron-builder --linux --dir --publish never > /dev/null
	@echo "--------------------------------"

build-win: build-setup build-install
	@echo "Building Electron app for Windows (dir, unsigned)..."
	@cd ${BUILD_DIR}/src; $(UNSIGNED_ENV) npx electron-builder --win --dir --publish never > /dev/null
	@echo "--------------------------------"

# ─── Dependencies ─────────────────────────────────────────────────────────────
install:
	@echo "Installing Node.js dependencies..."
	@cd $(SRC_DIR) && npm ci
	@echo "--------------------------------"

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

vendor-markdown:
	@echo "Bundling Markdown (marked + DOMPurify) vendor file..."
	@cd $(SRC_DIR); npm run vendor-markdown
	@echo "--------------------------------"

vendor-graphql:
	@echo "Bundling graphql-js vendor file..."
	@cd $(SRC_DIR); npm run vendor-graphql
	@echo "--------------------------------"

# ─── Distribution packages ────────────────────────────────────────────────────
# `dist` builds every platform, but a given host can only build its own
# (mac dmg needs macOS, etc.). CI runs dist-mac/linux/win on native runners;
# locally only the host-platform target will succeed.
#
# Signing & notarization: dist-mac/dist-win sign + (macOS) notarize when the
# credentials in RELEASE_ENV_VARS are present (release.env locally, secrets in
# CI). With none set the artifacts are simply unsigned — no failure. Verify a
# signed build with: codesign --verify --deep --strict <app> && spctl -a -vv
# <app> (macOS); signtool verify /pa <exe> (Windows).
dist: dist-mac dist-linux dist-win

dist-mac: build-setup build-install
	@echo "Building macOS distribution (dmg/zip)..."
	@cd ${BUILD_DIR}/src; npx electron-builder --mac --publish never
	@$(MAKE) staple-dmg
	@echo "  → ${BUILD_DIR}/src/dist/"
	@echo "--------------------------------"

dist-linux: build-setup build-install
	@echo "Building Linux distribution (AppImage/deb)..."
	@cd ${BUILD_DIR}/src; npx electron-builder --linux --publish never
	@echo "  → ${BUILD_DIR}/src/dist/"
	@echo "--------------------------------"

dist-win: build-setup build-install
	@echo "Building Windows distribution (nsis/portable)..."
	@cd ${BUILD_DIR}/src; npx electron-builder --win --publish never
	@echo "  → ${BUILD_DIR}/src/dist/"
	@echo "--------------------------------"

# ─── Notarize & staple the DMGs ───────────────────────────────────────────────
# electron-builder notarizes/staples the .app (it submits the zipped app), but
# leaves the .dmg wrapper unsigned and un-notarized — so a freshly-built .dmg is
# "not signed at all", `spctl` can't assess it, and `stapler` can't staple it
# (Apple has no record of the dmg's hash → error 65). This SIGNS each .dmg with
# the Developer ID Application identity, submits it to notarytool, and staples
# the returned ticket — so the disk image is itself signed + notarized and passes
# `spctl -a -t open` offline. Order matters: sign BEFORE notarizing (signing
# changes the dmg's hash, which would invalidate an existing ticket). Invoked by
# `dist-mac`; also runnable on its own to fix DMGs already in dist/ without a
# full rebuild.
#
# Notarization creds mirror electron-builder: App Store Connect API key
# (APPLE_API_*) if present, else Apple ID + app-specific password (APPLE_ID /
# APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID); with neither set it skips cleanly
# so unsigned / credential-less builds (local dev, CI PRs) still pass. The signing
# identity comes from $$CSC_NAME if set, else the first "Developer ID Application"
# identity in the keychain; if none is found (e.g. a CI runner where
# electron-builder's temp keychain is already gone) the dmg is notarized+stapled
# UNSIGNED rather than failing the build.
# NOTE: the app-specific password is passed as a flag, so it shows in `ps` for the
# duration of the submit (same as electron-builder's own notarytool call) — fine
# on single-tenant dev/CI machines; for a shared host pre-create a keychain
# profile (`xcrun notarytool store-credentials`) and switch to --keychain-profile.
staple-dmg:
	@set -e; \
	DIST="$(BUILD_DIR)/src/dist"; \
	dmgs=$$(ls "$$DIST"/*.dmg 2>/dev/null || true); \
	if [ -z "$$dmgs" ]; then echo "No .dmg in $$DIST — nothing to staple."; exit 0; fi; \
	if [ -n "$$APPLE_API_KEY" ] && [ -n "$$APPLE_API_KEY_ID" ] && [ -n "$$APPLE_API_ISSUER" ]; then \
		auth="--key $$APPLE_API_KEY --key-id $$APPLE_API_KEY_ID --issuer $$APPLE_API_ISSUER"; \
		echo "Notarizing DMG(s) via App Store Connect API key…"; \
	elif [ -n "$$APPLE_ID" ] && [ -n "$$APPLE_APP_SPECIFIC_PASSWORD" ] && [ -n "$$APPLE_TEAM_ID" ]; then \
		auth="--apple-id $$APPLE_ID --password $$APPLE_APP_SPECIFIC_PASSWORD --team-id $$APPLE_TEAM_ID"; \
		echo "Notarizing DMG(s) via Apple ID…"; \
	else \
		echo "No Apple notarization credentials set — skipping DMG notarization (unsigned build)."; \
		exit 0; \
	fi; \
	if [ -n "$$CSC_NAME" ]; then \
		identity="$$CSC_NAME"; \
	else \
		identity=$$(security find-identity -p codesigning -v 2>/dev/null | grep "Developer ID Application" | head -1 | awk '{print $$2}'); \
	fi; \
	for d in $$dmgs; do \
		if [ -n "$$identity" ]; then \
			echo "  → codesign (Developer ID) $$d"; \
			codesign --force --timestamp --sign "$$identity" "$$d"; \
		else \
			echo "  ! no Developer ID identity found — notarizing $$d UNSIGNED"; \
		fi; \
		echo "  → notarytool submit $$d"; \
		xcrun notarytool submit "$$d" $$auth --wait; \
		echo "  → stapler staple $$d"; \
		xcrun stapler staple "$$d"; \
	done; \
	echo "DMG sign + notarize + staple complete."

# ─── Release ──────────────────────────────────────────────────────────────────
# Cut a release (Model A — "shipped pointer"):
#   validate -> preflight (on main, clean, in sync with origin) -> gate on tests
#   -> bump src/package.json on main -> fast-forward `release` to main -> tag
#   -> atomic push of main + release + tag (the tag push triggers the build).
# `release` stays a strict fast-forward of `main`, so history is linear and the
# branch always points at exactly what was last shipped.
# Usage:  make release VERSION=1.2.3
MAIN_BRANCH    ?= main
RELEASE_BRANCH ?= release

release:
	@set -e; \
	NEW="$(VERSION)"; \
	if ! [[ "$$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$$ ]]; then \
		echo "Error: version must be in x.y.z format (got '$$NEW')."; \
		echo "Usage: make release VERSION=1.2.3"; exit 1; \
	fi; \
	ORIG=$$(git rev-parse --abbrev-ref HEAD); \
	trap 'git checkout "$$ORIG" --quiet 2>/dev/null || true' EXIT; \
	if [ "$$ORIG" != "$(MAIN_BRANCH)" ]; then \
		echo "Error: release must be run from '$(MAIN_BRANCH)' (currently on '$$ORIG')."; exit 1; \
	fi; \
	if ! git diff-index --quiet HEAD --; then \
		echo "Error: working tree has uncommitted changes; commit or stash first."; exit 1; \
	fi; \
	CURRENT=$$(cd $(SRC_DIR) && node -p "require('./package.json').version"); \
	if [ "$$NEW" = "$$CURRENT" ]; then \
		echo "Error: new version equals the current version ($$CURRENT)."; exit 1; \
	fi; \
	echo "Fetching origin..."; \
	git fetch --quiet --tags origin; \
	if git rev-parse -q --verify "refs/tags/v$$NEW" >/dev/null; then \
		echo "Error: tag v$$NEW already exists."; exit 1; \
	fi; \
	if ! git merge-base --is-ancestor origin/$(MAIN_BRANCH) $(MAIN_BRANCH); then \
		echo "Error: local '$(MAIN_BRANCH)' is behind/diverged from origin; pull or rebase first."; exit 1; \
	fi; \
	echo ""; \
	echo "  Current version: $$CURRENT"; \
	echo "  New version:     $$NEW"; \
	echo "  Flow: bump on $(MAIN_BRANCH) -> ff '$(RELEASE_BRANCH)' -> tag v$$NEW -> push (triggers build)"; \
	echo ""; \
	read -p "Run tests and cut release v$$NEW? [y/N] " ans; \
	if [[ "$$ans" != "y" && "$$ans" != "Y" ]]; then echo "Aborted."; exit 1; fi; \
	echo "Running test suite..."; \
	if ! $(MAKE) test; then echo "Tests failed; aborting release (no changes made)."; exit 1; fi; \
	echo "Bumping version on $(MAIN_BRANCH)..."; \
	(cd $(SRC_DIR) && npm version "$$NEW" --no-git-tag-version >/dev/null); \
	git add src/package.json src/package-lock.json; \
	git commit -m "Release v$$NEW" >/dev/null; \
	echo "Fast-forwarding $(RELEASE_BRANCH) to $(MAIN_BRANCH)..."; \
	if git show-ref --verify --quiet refs/remotes/origin/$(RELEASE_BRANCH); then \
		git checkout -B $(RELEASE_BRANCH) origin/$(RELEASE_BRANCH) --quiet; \
	elif git show-ref --verify --quiet refs/heads/$(RELEASE_BRANCH); then \
		git checkout $(RELEASE_BRANCH) --quiet; \
	else \
		git checkout -b $(RELEASE_BRANCH) --quiet; \
	fi; \
	git merge --ff-only $(MAIN_BRANCH) --quiet; \
	git tag -a "v$$NEW" -m "Release v$$NEW"; \
	echo "Pushing $(MAIN_BRANCH) + $(RELEASE_BRANCH) + tag v$$NEW (atomic)..."; \
	if ! git push --atomic origin $(MAIN_BRANCH) $(RELEASE_BRANCH) "v$$NEW"; then \
		echo "Push failed. Local commit/tag were created but nothing was pushed."; \
		echo "Retry with: git push --atomic origin $(MAIN_BRANCH) $(RELEASE_BRANCH) v$$NEW"; \
		exit 1; \
	fi; \
	echo "Released v$$NEW — the Release workflow will build and publish the installers."; \
	SLUG=$$(git remote get-url origin 2>/dev/null | sed -E 's#^.*github\.com[:/]##; s#\.git$$##'); \
	if [ -n "$$SLUG" ]; then \
		echo "  Release: https://github.com/$$SLUG/releases/tag/v$$NEW"; \
	fi

# ─── Synchronize Secrets ──────────────────────────────────────────────────────
# Push the macOS / Windows signing credentials from release.env up to this
# repo's GitHub Actions secrets (consumed by the Release workflow). The value is
# read via $(…) command substitution — which strips the trailing newline — then
# re-emitted with `printf %s` and piped to `gh secret set` (never echoed). A
# trailing newline would be stored verbatim and corrupt the secret (e.g. break
# notarization auth). Empty/missing keys are skipped so we never push a blank
# CSC_LINK (the empty-cert footgun the release.env export logic guards against).
sync-mac:
	@echo "Pushing mac secrets to GitHub repository secrets (for GitHub Actions)…"
	@for k in CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do \
		v=$$(grep "^$$k=" $(WORKSPACE)/release.env | head -1 | cut -d= -f2-); \
		if [ -z "$$v" ]; then echo "  ! $$k missing/empty in release.env — skipping"; continue; fi; \
		printf '%s' "$$v" | gh secret set "$$k" && echo "  ✓ $$k"; \
	done
	@echo "--------------------------------"

sync-win:
	@echo "Pushing windows secrets to GitHub repository secrets (for GitHub Actions)…"
	@for k in WIN_CSC_LINK WIN_CSC_KEY_PASSWORD; do \
		v=$$(grep "^$$k=" $(WORKSPACE)/release.env | head -1 | cut -d= -f2-); \
		if [ -z "$$v" ]; then echo "  ! $$k missing/empty in release.env — skipping"; continue; fi; \
		printf '%s' "$$v" | gh secret set "$$k" && echo "  ✓ $$k"; \
	done
	@echo "--------------------------------"

# ─── Launch ───────────────────────────────────────────────────────────────────
# `open` does not inherit the shell environment, so forward the shared dev vars
# explicitly with --env so the packaged app sees the same values as `make debug`.
launch: build-mac
	@open "build/src/dist/mac-arm64/Rest Hippo.app" \
		$(foreach v,$(DEV_ENV_VARS),--env $(v)=$($(v)))

# ─── Clean ────────────────────────────────────────────────────────────────────
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf $(BUILD_DIR) $(DIST_DIR)
	@echo "--------------------------------"

# ─── Help ─────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  Rest Hippo — Web URL REST API Client"
	@echo ""
	@echo "  Local builds:"
	@echo "    make          Unsigned, un-notarized macOS .dmg  (default; fast local testing)"
	@echo "    dmg           Unsigned, un-notarized macOS .dmg  (same as bare 'make')"
	@echo "    all           Unsigned, un-notarized installers for ALL platforms"
	@echo "    sign-dmg      Signed + notarized macOS .dmg  (ready to ship)"
	@echo "    sign-all      Signed installers for ALL platforms"
	@echo ""
	@echo "  Targets:"
	@echo "    install       Install Node.js dependencies (npm ci)"
	@echo "    debug         Run Electron with DevTools + hot-reload"
	@echo "    build         Build Electron app for macOS (dir only, unsigned)"
	@echo "    build-mac     Build Electron app for macOS (dir only, unsigned)"
	@echo "    build-linux   Build Electron app for Linux (dir only, unsigned)"
	@echo "    build-win     Build Electron app for Windows (dir only, unsigned)"
	@echo "    dist          Build full installers for all platforms (signed if creds present)"
	@echo "    release       Bump version, tag, and push to trigger a release (VERSION=x.y.z)"
	@echo "    dist-mac      Build macOS installer"
	@echo "    dist-linux    Build Linux installer"
	@echo "    dist-win      Build Windows installer"
	@echo "    vendor-yaml   Bundle yaml npm pkg → web/scripts/vendor/yaml.js"
	@echo "    vendor-prism  Bundle Prism.js → web/scripts/vendor/prism.js"
	@echo "    vendor-markdown  Bundle marked+DOMPurify → web/scripts/vendor/markdown.js"
	@echo "    vendor-graphql   Bundle graphql-js → web/scripts/vendor/graphql.js"
	@echo "    fmt           Format JS/CSS/HTML (prettier)"
	@echo "    fmt-check     Check formatting without writing (prettier --check)"
	@echo "    lint          Lint JS (eslint)"
	@echo "    test          Run all JavaScript + OAuth tests"
	@echo "    test-js       Run JavaScript store tests only"
	@echo "    test-cookies  Run cookie jar / store tests only"
	@echo "    test-oauth    Run OAuth 2.0 unit tests only"
	@echo "    clean         Remove build and dist directories"
	@echo "    version       Print version string"
	@echo "    info          Print full build information"
	@echo "    launch        build and launch the mac electron app"
	@echo ""
	@echo "Available targets for mock server"
	@echo "    mock-up       Build and start mock server on :8888 (+ proxy on :9999)"
	@echo "    mock-down     Stop mock server"
	@echo "    mock-build    Build mock server binary"
	@echo ""
	@echo "Available targets for keycloak"
	@echo "    kc_start      Start Keycloak in dev mode"
	@echo "    kc_wait       Wait until Keycloak is healthy"
	@echo "    kc_bootstrap  Configure realm, users, and clients"
	@echo "    kc_creds      Print OAuth/OpenID configuration details"
	@echo "    kc_stop       Stop and remove Keycloak container"
	@echo "    kc_reset      Stop container and delete volumes"
	@echo "    kc_all        Start + configure + creds"

# -----------------------------------------------------------------------------
# Start Keycloak
# -----------------------------------------------------------------------------
.PHONY: kc_start
kc_start:
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
.PHONY: kc_wait
kc_wait:
	@echo "Waiting for Keycloak to become ready..."
	@until curl -s http://localhost:$(KEYCLOAK_PORT)/realms/master >/dev/null 2>&1; do \
		sleep 3; \
		echo "  still waiting..."; \
	done
	@echo "Keycloak is ready"

# -----------------------------------------------------------------------------
# Bootstrap realm, users, and OAuth clients
# -----------------------------------------------------------------------------
.PHONY: kc_bootstrap
kc_bootstrap: kc_wait
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

	@echo "Creating Device Authorization Grant client..."
	@$(KC) create clients -r $(KEYCLOAK_REALM) \
		-s clientId=device-code-client \
		-s enabled=true \
		-s publicClient=true \
		-s standardFlowEnabled=false \
		-s directAccessGrantsEnabled=false \
		-s serviceAccountsEnabled=false \
		-s implicitFlowEnabled=false \
		-s 'attributes."oauth2.device.authorization.grant.enabled"=true' >/dev/null || true

	@echo "Creating Token Exchange client (RFC 8693, standard token exchange)..."
	@$(KC) create clients -r $(KEYCLOAK_REALM) \
		-s clientId=token-exchange-client \
		-s enabled=true \
		-s publicClient=false \
		-s secret=$(CLIENT_SECRET) \
		-s standardFlowEnabled=false \
		-s directAccessGrantsEnabled=true \
		-s serviceAccountsEnabled=true \
		-s implicitFlowEnabled=false \
		-s 'attributes."standard.token.exchange.enabled"=true' >/dev/null || true

	@echo "Adding token-exchange audience mapper to client-credentials-client..."
	@# Standard token exchange (v2) only lets a client exchange a token it is
	@# within the audience of. This mapper puts token-exchange-client into the
	@# aud of tokens issued by client-credentials-client, so a token minted by
	@# the Client Credentials request can be exchanged by the Token Exchange one.
	@CID=$$($(KC) get clients -r $(KEYCLOAK_REALM) -q clientId=client-credentials-client \
		--fields id --format csv --noquotes 2>/dev/null | head -1); \
	if [ -n "$$CID" ]; then \
		$(KC) create clients/$$CID/protocol-mappers/models -r $(KEYCLOAK_REALM) \
			-s name=token-exchange-audience \
			-s protocol=openid-connect \
			-s protocolMapper=oidc-audience-mapper \
			-s 'config."included.client.audience"=token-exchange-client' \
			-s 'config."access.token.claim"=true' \
			-s 'config."id.token.claim"=false' >/dev/null 2>&1 || true; \
	fi

	@echo "Bootstrap complete"

# -----------------------------------------------------------------------------
# Print configuration and curl examples
# -----------------------------------------------------------------------------
.PHONY: kc_creds
kc_creds:
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
	@echo "  Device Authorization Endpoint:"
	@echo "    http://localhost:$(KEYCLOAK_PORT)/realms/$(KEYCLOAK_REALM)/protocol/openid-connect/auth/device"
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
	@echo "Device Authorization Grant Client"
	@echo "  Client ID: device-code-client"
	@echo "  Public client (no secret)"
	@echo ""
	@echo "Token Exchange Client (RFC 8693)"
	@echo "  Client ID: token-exchange-client"
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
	@echo "Sample Device Authorization Request (step 1 — get the user code):"
	@echo "curl -X POST \
  http://localhost:$(KEYCLOAK_PORT)/realms/$(KEYCLOAK_REALM)/protocol/openid-connect/auth/device \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'client_id=device-code-client' \
  -d 'scope=openid'"
	@echo ""
	@echo "  then poll the token endpoint (step 2) with the returned device_code:"
	@echo "curl -X POST \
  http://localhost:$(KEYCLOAK_PORT)/realms/$(KEYCLOAK_REALM)/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=urn:ietf:params:oauth:grant-type:device_code' \
  -d 'client_id=device-code-client' \
  -d 'device_code=<DEVICE_CODE>'"
	@echo ""
	@echo "Sample Token Exchange Request (RFC 8693) — two steps:"
	@echo "  Step 1 — mint a subject token (client-credentials-client's token"
	@echo "  carries token-exchange-client in its audience, via the bootstrap mapper):"
	@echo "SUBJECT=\$$(curl -s -X POST \
  http://localhost:$(KEYCLOAK_PORT)/realms/$(KEYCLOAK_REALM)/protocol/openid-connect/token \
  -d 'grant_type=client_credentials' \
  -d 'client_id=client-credentials-client' \
  -d 'client_secret=$(CLIENT_SECRET)' | jq -r .access_token)"
	@echo ""
	@echo "  Step 2 — exchange it via token-exchange-client:"
	@echo "curl -X POST \
  http://localhost:$(KEYCLOAK_PORT)/realms/$(KEYCLOAK_REALM)/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  -d 'client_id=token-exchange-client' \
  -d 'client_secret=$(CLIENT_SECRET)' \
  -d \"subject_token=\$$SUBJECT\" \
  -d 'subject_token_type=urn:ietf:params:oauth:token-type:access_token'"
	@echo ""
	@echo "============================================================"

# -----------------------------------------------------------------------------
# Composite target
# -----------------------------------------------------------------------------
.PHONY: kc
kc: kc_start kc_bootstrap kc_creds

# -----------------------------------------------------------------------------
# Stop and remove container
# -----------------------------------------------------------------------------
.PHONY: kc_stop
kc_stop:
	@echo "Stopping and removing container..."
	@docker rm -f $(CONTAINER_NAME) >/dev/null 2>&1 || true
	@echo "Container removed"

# -----------------------------------------------------------------------------
# Full cleanup
# -----------------------------------------------------------------------------
.PHONY: kc_reset
kc_reset: kc_stop
	@echo "Removing Keycloak data volume (if present)..."
	@docker volume rm $(CONTAINER_NAME)-data >/dev/null 2>&1 || true
	@echo "Cleanup complete"

# -----------------------------------------------------------------------------
# Mock server (Go) — MIME type test API on http://localhost:8888, a forward
# proxy on http://localhost:9999 (X-Proxy-Error retry testing) and a SOCKS5
# proxy on localhost:9998. Set MOCK_PROXY_USER/MOCK_PROXY_PASS to require proxy
# auth (Basic on the forward proxy, RFC 1929 on SOCKS5).
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
	@echo "  GET http://localhost:$(MOCK_PORT)/delay?seconds=<1-30>  sleeps N seconds (clamped) then returns JSON"
	@echo "  GET http://localhost:$(MOCK_PORT)/auth"
	@echo "  GET http://localhost:$(MOCK_PORT)/auth/<type>"
	@echo "  ANY http://localhost:$(MOCK_PORT)/echo  reflects the request back (json/xml/yaml/html via Accept)"
	@echo "  POST http://localhost:$(MOCK_PORT)/graphql  GraphQL (introspection + user/users/createUser)"
	@echo "  WS  ws://localhost:$(MOCK_PORT)/ws  echo; /ws/time pushes a frame/sec; /ws/reject returns 401"
	@echo "  GET http://localhost:$(MOCK_PORT)/sse  index; /sse/events /sse/counter /sse/llm /sse/infinite stream SSE live"
	@echo "  GET http://localhost:$(MOCK_PORT)/ndjson  chunked NDJSON (enable the request Stream toggle)"
	@echo "Forward proxy on http://localhost:$(MOCK_PROXY_PORT)"
	@echo "  send X-Proxy-Error: <n>[:reset|timeout|<status>] to fail n-1 times per URL before succeeding"
	@echo "SOCKS5 proxy on socks5://localhost:$(MOCK_SOCKS_PORT)"
	@echo "  set MOCK_PROXY_USER / MOCK_PROXY_PASS to require proxy auth"
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
.PHONY: dmg all sign-dmg sign-all version info \
        install \
        fmt fmt-check \
        lint \
        test test-js test-cookies test-auth test-content-type test-ipc test-oauth test-export test-components test-import \
        test-data-store test-diagnostics test-renderer-components test-renderer-e2e \
        debug \
        build build-mac build-linux build-win \
        build-setup build-install \
        dist dist-mac dist-linux dist-win staple-dmg \
        release \
        sync-mac sync-win \
        vendor-yaml vendor-prism vendor-markdown vendor-graphql \
        clean help launch \
        mock-up mock-down mock-build \
        kc_start kc_wait kc_bootstrap kc_creds kc_stop kc_reset kc
