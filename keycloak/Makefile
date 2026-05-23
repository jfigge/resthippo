SHELL := /bin/bash

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
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

# -----------------------------------------------------------------------------
# Help
# -----------------------------------------------------------------------------
.PHONY: help
help:
	@echo "Available targets:"
	@echo "  make start            - Start Keycloak in dev mode"
	@echo "  make wait             - Wait until Keycloak is healthy"
	@echo "  make bootstrap        - Configure realm, users, and clients"
	@echo "  make creds.           - Print OAuth/OpenID configuration details"
	@echo "  make stop             - Stop and remove Keycloak container"
	@echo "  make reset            - Stop container and delete volumes"
	@echo "  make all              - Start + configure + creds"

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
.PHONY: all
all: start bootstrap creds

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