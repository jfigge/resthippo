# Feature 28 — Continuous integration (GitHub Actions)

## Context
There is **no CI** — no `.github/` directory and no CI config anywhere in the repo. Lint, test, and build
run only on the maintainer's machine via the `Makefile`. The IPC contract (44 reconciled channels), the
secret-encryption paths, and the atomic-write logic can regress unnoticed, and the app ships macOS/Linux/
Windows builds with no cross-platform verification.

A concrete gap to fix in passing: the cookie tests
(`src/app/store/tests/cookie-jar.test.js`, `cookie-store.test.js` — ~50 tests) exist but are **not wired
into any `Makefile` test target**, so `make test` never runs them.

## Goal
Add a GitHub Actions pipeline that runs format-check, lint, and the full test suite on every push/PR, plus
a build job that verifies the Electron app packages on macOS/Linux/Windows.

## Implementation steps
1. **Workflow**: add `.github/workflows/ci.yml`. On `push` and `pull_request`: checkout, set up Node
   (match the version the project targets), `make install`, then a check job running `make lint`,
   prettier in check mode, and `make test`.
2. **Fix the suite first**: wire the orphaned cookie tests into the aggregate `test` target in the
   `Makefile` so CI actually covers them; confirm `make test` is green locally before CI relies on it.
3. **Build matrix**: a separate job on `macos-latest` / `ubuntu-latest` / `windows-latest` running the
   per-platform `make build-*` (`--dir`, unsigned) to catch packaging breakage. Signing/notarization is
   Feature 31; keep `--publish never` here.
4. **Hygiene**: cache npm, fail fast on lint/test, upload test output as an artifact on failure. Add a
   status badge to `README.md`.

## Acceptance criteria
- Push/PR triggers a run that fails on a lint error, a test failure, or a formatting violation.
- The cookie tests run as part of `make test` (and therefore CI).
- The build matrix produces an unpacked app on all three OSes without signing.
- A passing run is green end-to-end from a clean checkout.

## Constraints
- Use the existing `Makefile` targets and the `node --test` runner — do not introduce a new test framework.
- No secrets required for the build matrix (unsigned `--dir`); signing creds belong to Feature 31.
- Check for other tests not executed

## Verify
`make fmt && make lint && make test` locally, then confirm the workflow is green on a PR.
