# RestHippo — Command Request Type

## Goal

Add a new **Command** request type to RestHippo, alongside REST, GraphQL and WebSocket. It runs a local command-line program and treats its output like any other response, so results (e.g. an auth token from a CLI) can be parsed and extracted into variables using the existing request-chaining and response-parsing capabilities. Motivating case: the Global Network Service (GNS) issues a token only via a command prompt.

## Platform scope

- Available in GitHub Releases builds on macOS (ARM and Intel), Windows and Linux.
- **Hidden entirely** in the Mac App Store build (sandbox blocks spawning arbitrary processes). Do not show it greyed out.

## Execution model

- Run the process **directly from the app**, not via a user shell: Node `child_process.spawn` with `shell: false`, executable plus an argument array.
- The environment is built **only from RestHippo's own variables system**, for consistency and predictability. No login-shell environment or PATH import.
- Provide a built-in, user-editable **PATH variable** with sensible per-platform defaults (macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`). The app resolves the executable against this PATH itself.
- Always allow a full absolute path to the executable.
- Windows: `.cmd` / `.bat` files are not found without a shell; resolve or require the full name (e.g. `az.cmd`) and handle this explicitly.

## Editor UI (mirrors the REST request)

- **Command line** goes where the URL normally goes.
- After a short typing pause (1–2 s), check whether the executable resolves on the PATH; **highlight it red** if not found.
- Parse the command line into executable plus arguments, respecting quotes.
- **Params tab → Arguments tab**, kept in two-way sync with the command line (like query params and the URL).
- **Headers tab → Environment variables.**
- **Body tab → stdin** piped into the process.

## Response mapping

- Exit code → status.
- stdout → response body.
- stderr → separate error panel.
- User-selectable content type for parsing stdout (e.g. JSON, plain text, regex extraction), so existing extraction into variables works unchanged.

## Run button

- Button label is **Execute**, with its own colour (method buttons are already colour-coded per method).
- While running it turns into the **red stop** button; press again to cancel.
- The existing dropdown / right-click menu (scheduled runs such as every 5 minutes or in 10 minutes, with a percentage countdown in the button) also applies.
- For command requests the menu adds a **Timeout** option. During execution the countdown shows in the button; if no result arrives in time, the run is cancelled automatically. Style the timeout countdown distinctly from the scheduled-run countdown.

## Cancellation

- Send SIGTERM, then SIGKILL after a short grace period if the process hasn't exited.
- On Windows, kill the whole process tree, since CLIs often spawn child processes.

## Large output

- Reuse RestHippo's existing large-response chunking for stdout and stderr; no new handling needed.
