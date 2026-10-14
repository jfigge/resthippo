/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * auth/utils/state.js
 *
 * OAuth 2.0 state parameter — CSRF protection for authorization code and
 * implicit flows (RFC 6749 §10.12).
 *
 * A domain-named facade over the shared single-use TTL registry
 * (see ttl-registry.js): each state is a 64-character cryptographically random
 * hex string that expires after 10 minutes and is consumed on first successful
 * validation.
 */

"use strict";

import { createTtlRegistry } from "./ttl-registry.js";

const _states = createTtlRegistry();

/**
 * Generate and register a cryptographically secure state string.
 * @returns {string} 64-hex-character random value
 */
export function generateState() {
  return _states.generate();
}

/**
 * Validate (and consume) a state value received in an authorization callback.
 * @param {string|null|undefined} state - Value from the callback URL
 * @returns {boolean}
 */
export function validateState(state) {
  return _states.validate(state);
}

/**
 * Discard a previously generated state without validating it.
 * Call this when the popup is cancelled before a callback arrives.
 * @param {string} state
 */
export function discardState(state) {
  _states.discard(state);
}
