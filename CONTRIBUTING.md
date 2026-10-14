# Contributing to Rest Hippo

Thanks for your interest in improving Rest Hippo! This document explains how to
get set up, the conventions the project follows, and — importantly — how to
certify your contributions via the **Developer Certificate of Origin (DCO)**.

## License of contributions

Rest Hippo is licensed under the [GNU General Public License, version 3 or
later](LICENSE) (`GPL-3.0-or-later`). By contributing, you agree that your
contributions are licensed under the same terms (GPL-3.0-or-later), and you
certify that you have the right to submit them under that license via the DCO
below.

## Developer Certificate of Origin (DCO)

Instead of a Contributor License Agreement, this project uses the
[Developer Certificate of Origin](DCO) — a lightweight statement that you wrote
the patch or otherwise have the right to submit it under the project's open
source license. The full text is in the [`DCO`](DCO) file.

You certify the DCO by adding a `Signed-off-by` line to every commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must match your Git author identity. Git adds this line for
you automatically with the `-s`/`--signoff` flag:

```bash
git commit -s -m "Fix digest-auth nonce reuse"
```

### Set it up once

So you never forget the flag, configure your identity and (optionally) an alias:

```bash
git config user.name  "Your Name"
git config user.email "your.email@example.com"
git config alias.ci   "commit -s"   # then use: git ci -m "…"
```

### Fixing missing sign-offs

If CI reports a commit without a sign-off, add it retroactively and re-push:

```bash
# Last commit only:
git commit --amend --signoff --no-edit && git push --force-with-lease

# A whole branch (against the PR base branch, usually main):
git rebase --signoff origin/main && git push --force-with-lease
```

A GitHub Actions check ([`.github/workflows/dco.yml`](.github/workflows/dco.yml))
enforces this on every pull request; a PR cannot merge until all of its commits
are signed off.

## Development setup

```bash
make install      # Install npm dependencies
make debug        # Run Electron with DevTools + hot-reload (primary dev workflow)
make fmt          # Format JS/CSS/HTML via Prettier
make lint         # Lint JS via ESLint
make test         # Run the full test suite
```

See [`CLAUDE.md`](CLAUDE.md) for the project's architecture and the full set of
conventions (component communication, i18n, popups, the feature test suite,
etc.). Please follow them — they are enforced by tests and the pre-commit hook.

## License headers

Every first-party source file should carry the standard GPL-3.0 header
comment at the top (after any shebang). When you add a new `.js`/`.css` file
under `src/`, prepend:

```js
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
```

This is checked by `make test-license-headers` and runs in CI and the pre-commit
hook. Generated bundles and vendored third-party code are exempt — see
`CLAUDE.md`. You can stamp any missing headers automatically with
`make license-headers`.

## Submitting changes

1. Make your change with focused commits, each signed off (`git commit -s`).
2. Run `make fmt lint test` locally — these must pass.
3. Open a pull request describing the change and the motivation.
4. Ensure the **DCO** and **CI** checks are green.

Thanks for contributing! 🦛
