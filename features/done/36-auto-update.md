# Feature 36 — Auto-update (electron-updater)

## Context
There is no update mechanism: no `autoUpdater`/`electron-updater` dependency and no `electron-builder`
`publish` config — every build/dist target passes `--publish never` (`Makefile`). Every release is a manual
re-download, so users run stale (and potentially vulnerable) builds indefinitely.

## Goal
Add signed auto-updates: the app checks a release feed, downloads updates in the background, and prompts
the user to restart-and-install, with a manual "Check for updates" action.

## Implementation steps
1. **Publish target**: configure `electron-builder` `publish` (e.g. GitHub Releases or a generic feed) and
   generate update metadata (`latest*.yml`) during `make dist`. This depends on **Feature 31** — updates
   must be signed/notarized to install cleanly.
2. **Updater (main)**: integrate `electron-updater`'s `autoUpdater` in `main.js`: check on startup
   (debounced) and on demand; download in the background; emit progress + "ready" events. Add a
   `Check for Updates…` item to the application menu.
3. **User flow**: notify when an update is available/downloaded (reuse Feature 26 notifications) and offer
   "Restart to update". Never auto-restart without consent. Surface updater errors instead of swallowing
   them.
4. **CI release**: wire publishing into the tag/release job from Feature 28, gated on signing secrets. 
   Update the web site with the new version and binaries.

## Acceptance criteria
- The app detects a newer published release and downloads it in the background.
- The user is prompted and can restart to apply; declining keeps the current version.
- "Check for Updates…" works on demand and reports "up to date" or progress/errors visibly.
- Updates install without Gatekeeper/SmartScreen prompts (because artifacts are signed — Feature 31).

## Constraints
- Requires Feature 31 (signing/notarization) to be in place.
- Don't ship telemetry; the update check should be the only outbound call this feature adds.
- Keep `main.js`/`preload.js` in sync; do not modify `build/`.

## Verify
`make fmt && make lint && make test`, then validate an end-to-end update against a test release feed.
