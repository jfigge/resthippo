# Feature 53 — Voluntary donation (tip jar)

## Context
Rest Hippo is entirely free with no paid tier, license check, trial, or payment path of any kind, and no
way for users who value the app to support it. We want a low-friction, **completely optional** "tip
jar" — a suggested **$5** thank-you — that simply opens a hosted payment page in the system browser.
The app already opens external web URLs from the main process via `shell.openExternal` with a scheme
allow-list (`src/app/main.js` ~1493 for OAuth, ~2024 for doc links), and the native menus are built in
`main.js` (Help submenu ~2409) with main-process i18n via `m("menu.…", "fallback")`. This feature
reuses those seams rather than introducing any in-app payment processing.

## Goal
Add an unobtrusive "Support Rest Hippo" action that opens a hosted donation/checkout page (suggested $5) in
the user's browser. Donating is a pure thank-you: it unlocks **nothing** and is never required, gated,
nagged, or verified.

## Implementation steps
1. **Config**: add a single configurable donation URL constant (e.g. `DONATE_URL`) in one place in the
   main process — do not scatter it. The suggested amount ($5) is owned by the hosted page; the app only
   opens the link. Pick a provider whose hosted page handles the transaction end-to-end (no card data
   touches the app): GitHub Sponsors, a Stripe Payment Link, Buy Me a Coffee, Ko-fi, or PayPal.me.
   Recommend one in the PR description and leave the URL trivially swappable.
2. **Help menu (primary surface)**: add a `Support Rest Hippo…` item to the Help submenu (`main.js` ~2409),
   near `menu.userGuide`. Its `click` handler runs in main, so it calls `shell.openExternal(DONATE_URL)`
   directly — guard with the same `https:`-only scheme check used at ~2024; no IPC needed for the menu
   path.
3. **Optional in-app affordance**: a small, dismissible "♥ Support Rest Hippo — $5" button in Settings →
   About (follow existing `SettingsPopup`/settings conventions). If added, the renderer routes the open
   through the existing external-open IPC if one exists, else add an `ui:open-external` channel and keep
   `main.js`/`preload.js` in sync. Keep it quiet — no launch-time modal, no recurring prompt, no badge.
4. **i18n**: every new user-facing string goes through `t()` (renderer) / `m()` (native menu) and is
   added to `en.json` **and** translated into `de`, `es`, `fr`, `it`, `ja`, `zh` in the same change.
   Keep the literal "$5" / currency presentation consistent with how the hosted page bills.
5. **User guide**: add a short "Supporting Rest Hippo" note to the relevant docs page (e.g.
   `getting-started.md`) describing the optional tip and that nothing is gated behind it.

## Acceptance criteria
- A `Support Rest Hippo…` item appears in the Help menu and opens the donation page in the default browser.
- The donation page (or its absence) never blocks, gates, or alters any feature — the app behaves
  identically whether or not a user ever donates.
- No launch-time or recurring nag: the affordance is passive and must be sought out by the user.
- All new strings are localized across all seven shipped locales; native menu label included.
- Only `https:` URLs are handed to `shell.openExternal` (scheme allow-list honored).

## Constraints
- **No restricted features.** There is no premium tier, no license/key, no "unlock", no donation
  verification, and no phone-home to check donor status. The tip jar is purely voluntary.
- **No payment processing in-app** — no card entry, no native in-app-purchase, no PCI scope. The app
  only opens a hosted page; the provider owns the transaction.
- **No telemetry** — opening the link is the only outbound call this feature adds; do not track clicks,
  conversions, or donor identity (consistent with Feature 36's stance).
- Plain DOM + class-based ES module for any renderer UI; CSS tokens from `theme.css`. Keep
  `main.js`/`preload.js` in sync for any new IPC. Do not modify `build/`.
- Any in-app affordance must be keyboard-operable and screen-reader labeled.

## Verify
`make fmt && make lint && make test` (including `make test-i18n` for locale completeness + the
no-hardcoded-strings guard), then in `make debug` confirm the Help → `Support Rest Hippo…` item opens the
donation URL in the browser, and verify no feature is gated and no prompt nags on startup.
