# Command Requests

[← Back to contents](README.md)

A **Command** request runs a program on your computer and treats its output like
any other response. That lets you use a command-line tool inside a request
chain. For example, a service that only issues access tokens through a CLI can
supply the token for the next HTTP request: Rest Hippo runs the CLI, captures
the token from its output into a variable, and the next request sends it.

> Command requests are available in the GitHub Releases builds for macOS,
> Windows and Linux. They are **not** available in the Mac App Store build,
> because the App Store sandbox doesn't allow apps to start other programs.

Create one from the tree: right-click a folder → **Add Command Request**, or
right-click the **+** button above the tree. You can also use **File → New
Command Request** (<kbd>⌥⇧⌘</kbd>/<kbd>Ctrl+Alt+Shift</kbd>+<kbd>N</kbd>).

## The command editor

A Command request uses the same layout as an HTTP request:

| HTTP request | Command request                                      |
| ------------ | ---------------------------------------------------- |
| URL bar      | **Command line**: the program and its arguments      |
| Method       | **CMD** badge, which also sets the output type       |
| Params tab   | **Arguments** tab                                    |
| Headers tab  | **Environment** tab                                  |
| Body tab     | **Stdin** tab: text sent to the program's input      |
| Send         | **Execute**                                          |

### The command line

Type the program followed by its arguments, for example:

```
gns token --audience api --format json
```

- Separate arguments with spaces. To put spaces inside one argument, wrap it in
  quotes: `--name 'John Smith'` or `--name "John Smith"`.
- `{{variables}}` and functions work anywhere on the line. They are filled in
  **after** the line is split into arguments, so a value that contains spaces
  is still passed as a single argument.
- No shell is involved, so there are no pipes (`|`), redirects (`>`), globs
  (`*`) or `$VAR` substitutions. Rest Hippo starts the program directly with
  exactly the arguments you see on the **Arguments** tab.
- On Windows a backslash is just a character, so `C:\tools\gns.exe` works
  as typed.

When you pause typing for about a second, Rest Hippo checks whether it can find
the program on the command **PATH**. If it can't, the command line turns **red**
and its tooltip explains why. You can always give a full path such as
`/opt/tools/gns` instead.

> **Windows:** `.cmd` and `.bat` scripts (for example `az`, which installs as
> `az.cmd`) are found through `PATHEXT` like `.exe` files. Rest Hippo runs them
> through `cmd.exe` and escapes every argument, so characters like `&` or `|`
> reach the script unchanged.

### Arguments

The **Arguments** tab lists every argument on its own row and stays in sync
with the command line in both directions. Edits on either side update the
other. You can add, delete or drag rows to reorder them. When you edit one
argument, the other arguments keep their original quoting. The tab also shows
which file the program name resolves to, for example
`gns → /opt/homebrew/bin/gns`.

### Environment

The program does **not** inherit Rest Hippo's own environment variables. It
gets exactly two sets of variables:

1. the **base environment** from **Settings → Commands**, and
2. this request's **Environment** rows, which override the base environment.

A row's value can use `{{variables}}`. For example, a row
`PATH = /opt/gns/bin:{{defaultPath}}` changes where the program is looked up
for this request only. The **Inherited from Settings → Commands** section at
the bottom of the tab lists the base environment.

### Stdin

Text on the **Stdin** tab is sent to the program's standard input. It supports
`{{variables}}`. If the tab is empty, standard input is closed immediately, so a
program waiting for input doesn't hang.

### Output type

Click the **CMD** badge to choose how the program's output (stdout) is shown and
parsed: **Auto-detect** (the default), **JSON**, **YAML**, **XML** or
**Plain text**. The badge shows your choice, for example `CMD · JSON`.

## Running and stopping

Click **Execute** (or press <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd>). While the
command runs, the button becomes a red **Stop**. Clicking it stops the program:
Rest Hippo first asks it to exit, and forces it to stop if it hasn't exited
after a couple of seconds. On Windows the whole process tree is stopped, so
helper processes started by the CLI stop too.

The Execute button has the same menu as **Send** (click the caret, or
right-click the button), so **Delayed** and **Interval** runs work for commands
too. Commands also have a **Timeout…** option in that menu. When a timeout is
set, the Stop button counts down (`Stop · 12s`) with a striped bar along its
bottom edge. If the program hasn't finished when the countdown ends, Rest Hippo
stops it. Set the timeout to `0` to turn it off.

### Approving commands

A Command request runs a real program, so Rest Hippo asks you to confirm before
a command runs for the first time, and again whenever its command line,
environment or stdin changes. The dialog shows the command line (with variables
not yet filled in) and the names of its environment variables. Changing the
**values** of variables doesn't trigger a new prompt.

Commands you type or edit yourself are approved automatically. This prompt
mostly protects you when you open a collection someone else made: an imported
command can't run silently, even when it runs as a dependency of another request
or as part of a folder run. Approvals are stored only on this computer and are
never exported or backed up.

## The response

| Program result | Shown as                                                    |
| -------------- | ----------------------------------------------------------- |
| Exit code      | The status, e.g. **Exit 0** (success) or **Exit 1** (error) |
| stdout         | The **Body** tab, rendered using the output type            |
| stderr         | The **Stderr** tab (marked with a dot when it has content)  |

The **Console** tab lists the resolved program path, each argument and the
**names** of the environment variables that were passed. Values aren't listed,
because they may be secrets. A program that can't be found or started, or that
runs past its timeout, appears as an error with a suggested fix. Very large
output is handled like a large HTTP body: Rest Hippo shows the beginning, and
you can choose **View full** or **Save to file**.

## Using the output in other requests

The output works with all of Rest Hippo's chaining features:

- **Captures:** pull a value out of stdout into a variable. Use a **Body**
  dot-path (`.access_token`) for JSON, YAML or XML output, or the **Regex**
  source for plain text. For example, `token=(\S+)` captures the first group.
  The default **2xx** code selector means *on success* (exit code `0`), and
  `4xx`/`5xx` mean *on failure* (any non-zero exit code). You can also enter an
  exact exit code such as `3`.
- **Request functions:** `{{response("Get GNS token", ".access_token")}}` in
  another request runs the command first when needed, then reads the value from
  its output.
- **Tests and scripts:** `hippo.response.status` is the exit code and
  `hippo.response.body` is stdout.

Command requests can't be exported to Postman, Insomnia, OpenAPI or HAR, because
those formats have no equivalent, so they are left out of those exports. Rest
Hippo's own export and backup keep them.

---

Next: [Reading Responses →](responses.md)
