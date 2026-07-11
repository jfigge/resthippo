/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * auth/flows/device-code.js
 *
 * OAuth 2.0 Device Authorization Grant — RFC 8628.
 *
 * The flow for input-constrained / headless clients (CLIs, TVs, IoT):
 *   1. POST the device-authorization endpoint → device_code, user_code,
 *      verification_uri, (verification_uri_complete), expires_in, interval.
 *   2. Show the user the user_code + verification URL so they can approve on a
 *      second device (popup/device-code-prompt.js).
 *   3. Poll the token endpoint with the device_code, honouring `interval`,
 *      backing off on `slow_down`, continuing on `authorization_pending`, and
 *      failing on `access_denied` / `expired_token` / the `expires_in` deadline.
 *
 * Unlike the other token-acquiring grants this drives its own poll loop rather
 * than reusing token-request.js#requestToken, because the device grant treats a
 * 400 with `authorization_pending` / `slow_down` as a *continue*, not a terminal
 * error. The successful result is cached/refreshed by the executor exactly like
 * any other grant.
 */

"use strict";

import { t } from "../../i18n.js";
import { postTokenRequest } from "../network/electron-network.js";
import { applyClientAuth } from "./token-request.js";
import { mergeExtraParams } from "../utils/params.js";
import {
  oauthResultFromTokenResponse,
  oauthResultFromError,
  DEVICE_CODE_GRANT_TYPE,
} from "../types/oauth-types.js";
import {
  OAuthError,
  OAuthErrorCode,
  fromTokenErrorResponse,
  fromNetworkError,
  popupCancelledError,
} from "../types/oauth-errors.js";
import { showDeviceCodePrompt } from "../popup/device-code-prompt.js";

/** Default poll interval (RFC 8628 §3.5) when the server omits `interval`. */
const DEFAULT_INTERVAL_S = 5;
/** Backoff added to the interval on a `slow_down` response (RFC 8628 §3.5). */
const SLOW_DOWN_BACKOFF_S = 5;
/** Fallback device_code lifetime when the server omits `expires_in`. */
const DEFAULT_EXPIRES_S = 1800;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute the Device Authorization grant.
 *
 * @param {object} config - authOAuth2 state from the request editor
 * @param {object} [opts]
 * @param {(ms: number) => Promise<void>} [opts.sleep] - injectable delay (tests)
 * @param {typeof showDeviceCodePrompt} [opts.prompt]  - injectable prompt (tests)
 * @returns {Promise<import('../types/oauth-types').OAuthResult>}
 */
export async function deviceCodeFlow(config, opts = {}) {
  // Config (clientId + deviceAuthorizationUrl validity) is validated up front by
  // the executor via validateOAuthConfig(); this flow assumes a valid config.
  const sleep = opts.sleep ?? defaultSleep;
  const prompt = opts.prompt ?? showDeviceCodePrompt;
  const clientId = config.clientId.trim();
  const tokenUrl = config.accessTokenUrl.trim();

  // ── 1. Request device + user codes ────────────────────────────────────────
  const deviceParams = {};
  if (config.scope?.trim()) deviceParams.scope = config.scope.trim();
  mergeExtraParams(deviceParams, config.extraParams);
  const deviceHeaders = {};
  applyClientAuth(deviceParams, deviceHeaders, config);

  let deviceResp;
  try {
    deviceResp = await postTokenRequest(
      config.deviceAuthorizationUrl.trim(),
      deviceParams,
      {
        headers: deviceHeaders,
        verifySsl: config.verifySsl !== false,
        timeout: config.timeout ?? 30_000,
      },
    );
  } catch (err) {
    return oauthResultFromError(
      err instanceof OAuthError ? err : fromNetworkError(err),
    );
  }

  if (deviceResp.error || deviceResp.httpStatus >= 400) {
    return oauthResultFromError(
      fromTokenErrorResponse(deviceResp, deviceResp.httpStatus),
    );
  }

  const deviceCode = deviceResp.device_code;
  const userCode = deviceResp.user_code;
  if (!deviceCode || !userCode) {
    return oauthResultFromError(
      new OAuthError(
        OAuthErrorCode.MALFORMED_RESPONSE,
        "Device authorization response is missing device_code / user_code.",
      ),
    );
  }

  let intervalMs = (Number(deviceResp.interval) || DEFAULT_INTERVAL_S) * 1_000;
  const expiresInS = Number(deviceResp.expires_in) || DEFAULT_EXPIRES_S;
  const deadline = Date.now() + expiresInS * 1_000;

  // ── 2. Show the user-code prompt ──────────────────────────────────────────
  let cancelled = false;
  const handle = await prompt(
    {
      userCode,
      verificationUri: deviceResp.verification_uri,
      verificationUriComplete: deviceResp.verification_uri_complete,
      expiresIn: expiresInS,
    },
    { onCancel: () => (cancelled = true) },
  );

  // ── 3. Poll the token endpoint ────────────────────────────────────────────
  try {
    while (true) {
      await sleep(intervalMs);
      if (cancelled) return oauthResultFromError(popupCancelledError());
      if (Date.now() >= deadline) {
        return oauthResultFromError(
          new OAuthError(
            OAuthErrorCode.TOKEN_EXPIRED,
            "The device code expired before authorization was granted.",
          ),
        );
      }

      const pollParams = {
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: deviceCode,
      };
      const pollHeaders = {};
      applyClientAuth(pollParams, pollHeaders, config);
      // The device grant always identifies the client in the body even under
      // header auth, so the IdP can bind the poll to the issued device_code.
      pollParams.client_id = clientId;

      let resp;
      try {
        resp = await postTokenRequest(tokenUrl, pollParams, {
          headers: pollHeaders,
          verifySsl: config.verifySsl !== false,
          timeout: config.timeout ?? 30_000,
        });
      } catch (err) {
        return oauthResultFromError(
          err instanceof OAuthError ? err : fromNetworkError(err),
        );
      }

      if (resp.access_token) {
        return oauthResultFromTokenResponse(resp);
      }

      switch (resp.error) {
        case "authorization_pending":
          handle.update?.({ status: t("auth.oauth2.device.waiting") });
          continue;
        case "slow_down":
          intervalMs += SLOW_DOWN_BACKOFF_S * 1_000;
          continue;
        case "access_denied":
          return oauthResultFromError(
            new OAuthError(
              OAuthErrorCode.ACCESS_DENIED,
              "The authorization request was denied.",
              resp.httpStatus,
            ),
          );
        case "expired_token":
          return oauthResultFromError(
            new OAuthError(
              OAuthErrorCode.TOKEN_EXPIRED,
              "The device code expired before authorization was granted.",
              resp.httpStatus,
            ),
          );
        default:
          return oauthResultFromError(
            fromTokenErrorResponse(resp, resp.httpStatus),
          );
      }
    }
  } finally {
    handle.close?.();
  }
}
