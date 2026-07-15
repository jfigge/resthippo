# Feature 69 — Sync: remote git (version control Phase 2)

## Context
Version control **Phase 1 (local)** is done: Rest Hippo maintains a **redacted git projection** of the store
under Electron `userData/repo/` — a committed mirror of collections/requests/environments where **secret
values are stripped**, tree ordering lives in `structure.json` (the full tree), and each request file holds
content only. The live encrypted store is *not* the tracked thing; the projection is. There is no remote:
you cannot push this repo anywhere, so collections can't move between machines or be shared with a team.
(See the local projection under `userData/repo/`; locate the Phase-1 projection/commit module in
`src/app/` and build on it — do not re-implement the projection.)

**Phase 2 = remotes.** Push/pull the redacted projection to a hosted remote (GitHub/GitLab/generic HTTPS or
SSH), so a user syncs their own collections across machines and teammates can share a collection — while
secrets **never leave the machine** (the redaction boundary is the whole security model here).

## Goal
Let a user configure a remote for the projection repo and **push/pull** it, with credential storage, sync
status, and conflict handling — such that structure and non-secret content sync, and each machine supplies
its own secrets locally.

## Implementation steps
1. **Remote config (main process).** Add settings for a remote URL + auth: HTTPS with a **personal access
   token** (stored via the existing `secret-storage`, never in plaintext/settings) or SSH key. IPC:
   `git:remote:set`, `git:remote:get`. Register in `main.js`, expose in `preload.js`. Reuse whatever git
   mechanism Phase 1 uses (a bundled git binding or spawned `git`); keep it main-process only.
2. **Push.** `git:push` — commit any pending projection changes (Phase 1 already builds the projection),
   then push to the configured remote/branch. Redact-verify before push: assert no secret material is in
   the tree (belt-and-suspenders over Phase 1 redaction) and that a `.gitignore` excludes any secret/temp
   files.
3. **Pull + apply-to-live-store (the hard part).** `git:pull` — fetch/merge the remote projection, then
   **merge changes back into the live store**: reconcile `structure.json` ordering + per-request content
   into collections/requests/environments without clobbering the user's local secrets (secrets aren't in
   the projection, so a pulled request must *keep* the local machine's secret values for matching ids and
   leave placeholders for new ones). This is bidirectional where Phase 1 was write-only — design the
   projection→live merge carefully and cover it with tests.
4. **Conflict handling.** Detect diverged history (ahead/behind/conflict). Offer a resolution path: prefer
   a simple **theirs/mine per-document** choice surfaced in the UI over raw git conflict markers; fall back
   to a clear "manual resolve in the repo" message when a clean auto-merge isn't possible.
5. **Sync UI.** A Sync panel (in Settings or its own surface): remote URL + credential entry (secret field),
   push/pull buttons, status (clean / N ahead / N behind / conflict), last-sync time, and a diff/summary of
   what a pull will change before it's applied. Route errors through Feature 26 notifications.
6. **Security surfacing.** Make it explicit in the UI + user guide that **secrets do not sync** (they live
   in the OS keychain per machine) and how a teammate/new machine supplies its own after a pull.
7. **User guide.** Extend the import/export/backup page (or add a Sync page) covering remote setup, the
   redaction boundary, and conflict resolution.

## Acceptance criteria
- A user can set an HTTPS+token (or SSH) remote and **push** the projection; the token is stored via
  `secret-storage`, never in plaintext.
- **Pull** merges remote changes into the live store: structure/order and non-secret content update, local
  secret values for existing requests are preserved, and new secret fields show as unset placeholders.
- The pushed repo contains **no secret values** (verified by a test over the projection output).
- Ahead/behind/conflict status is shown; a diverged pull offers a per-document theirs/mine resolution (or a
  clear manual-resolve fallback) and never silently discards local work.
- Sync errors surface via notifications; `make fmt && make lint && make test` is green.

## Constraints
- All git + filesystem + credential operations live in the **main process**; renderer talks only over
  `window.hippo.*` IPC. Keep `main.js`/`preload.js` in sync.
- Build on the Phase-1 projection (`userData/repo/`, `structure.json`, redaction) — do **not** fork a second
  projection or track the live encrypted store. Secrets must never enter a commit; the redaction boundary is
  non-negotiable.
- The projection→live merge must be non-destructive on failure (mirror the store's anti-clobber / atomic-
  write discipline) and schema-version aware (`migrations.js`).
- Plain DOM + class-based ES modules; CSS tokens from `theme.css`; secret entry uses the existing secret
  field; every user string via `t()` and translated into all seven catalogs.

## Verify
`make fmt && make lint && make test` (including a projection-redaction test), then `make debug`: set a remote,
push, clone/pull on a second profile, and confirm structure/content sync while secrets stay local.
