# Keyboard Shortcuts

[← Back to contents](README.md)

> On macOS use <kbd>⌘</kbd> (Command); on Windows/Linux use <kbd>Ctrl</kbd>.

## Global

These work anywhere in the app. Press <kbd>⌘/Ctrl</kbd>+<kbd>K</kbd> at any time
to pop up a quick reference to the most common shortcuts inside Rest Hippo.

| Shortcut                                          | Action                                                  |
| ------------------------------------------------- | ------------------------------------------------------- |
| <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd>                | Send the request (or WebSocket message when connected)  |
| <kbd>⌘/Ctrl</kbd>+<kbd>N</kbd>                    | New request                                             |
| <kbd>⌥⌘</kbd>/<kbd>Ctrl+Alt</kbd>+<kbd>N</kbd>    | New WebSocket request                                   |
| <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>   | New collection (or folder when a node is selected)      |
| <kbd>⌘/Ctrl</kbd>+<kbd>L</kbd>                    | Focus the URL bar                                       |
| <kbd>⌥⌘</kbd>/<kbd>Ctrl+Alt</kbd>+<kbd>↑</kbd>    | Select the previous request                             |
| <kbd>⌥⌘</kbd>/<kbd>Ctrl+Alt</kbd>+<kbd>↓</kbd>    | Select the next request                                 |
| <kbd>⌘/Ctrl</kbd>+<kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> | Switch to the Requests / Favorites / Recent tab   |
| <kbd>⌘/Ctrl</kbd>+<kbd>\\</kbd>                   | Cycle through the panel layouts                         |
| <kbd>⌘/Ctrl</kbd>+<kbd>,</kbd>                    | Open Settings                                           |
| <kbd>⌘/Ctrl</kbd>+<kbd>E</kbd>                    | Edit the active environment's variables                 |
| <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>  | Edit the selected folder's variables                    |
| <kbd>⌥⌘</kbd>/<kbd>Ctrl+Alt</kbd>+<kbd>E</kbd>   | Edit the active collection's variables                  |
| <kbd>⌘/Ctrl</kbd>+<kbd>K</kbd>                    | Open the keyboard-shortcuts cheat-sheet                 |
| <kbd>⌘/Ctrl</kbd>+<kbd>/</kbd>                    | Open the User Guide                                     |
| <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd>   | Import a collection                                     |

The navigation keys (focus URL, next/previous request, switch tab) yield to text
entry — they only fire when you aren't typing in a field. The application menus
also list these accelerators next to their commands.

> **There's no Save shortcut — you don't need one.** Every edit you make to a
> request (its method, URL, params, headers, body, auth, …) is **saved
> automatically** a moment after you stop typing. Your work is always persisted;
> there is no unsaved state to lose.

## Sending requests

| Shortcut                           | Action                                          |
| ---------------------------------- | ----------------------------------------------- |
| <kbd>Enter</kbd>                   | Send the request (while the URL bar is focused) |
| <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> | Send the request, or a WebSocket message when connected |

## Response viewer

| Shortcut                                        | Action                                  |
| ----------------------------------------------- | --------------------------------------- |
| <kbd>⌘/Ctrl</kbd>+<kbd>F</kbd>                  | Open the find-in-response bar           |
| <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> | Open the filter bar (JSON / YAML / XML) |
| <kbd>Enter</kbd>                                | Next match (in the find bar)            |
| <kbd>Shift</kbd>+<kbd>Enter</kbd>               | Previous match (in the find bar)        |
| <kbd>⌘/Ctrl</kbd>+<kbd>A</kbd>                  | Select the entire response body         |
| <kbd>Esc</kbd>                                  | Close the find or filter bar            |

## Editors & typeahead

| Shortcut                          | Action                                |
| --------------------------------- | ------------------------------------- |
| `{{`                              | Open the variable typeahead           |
| <kbd>↑</kbd> / <kbd>↓</kbd>       | Move through autocomplete suggestions |
| <kbd>Enter</kbd> / <kbd>Tab</kbd> | Accept the highlighted suggestion     |
| <kbd>Esc</kbd>                    | Dismiss suggestions                   |
| <kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd>                   | Undo in the focused editor field |
| <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>  | Redo in the focused editor field |

## Appearance

| Shortcut                       | Action             |
| ------------------------------ | ------------------ |
| <kbd>⌘/Ctrl</kbd>+<kbd>+</kbd> | Increase font size |
| <kbd>⌘/Ctrl</kbd>+<kbd>-</kbd> | Decrease font size |
| <kbd>⌘/Ctrl</kbd>+<kbd>0</kbd> | Reset font size    |

## Navigating the request tree

The collections tree is a single keyboard stop: <kbd>Tab</kbd> into it once, then
move around entirely with the arrow keys — you don't tab through every row.

| Shortcut                          | Action                                                  |
| --------------------------------- | ------------------------------------------------------- |
| <kbd>Tab</kbd>                    | Move focus into the tree (lands on the selected request)|
| <kbd>↑</kbd> / <kbd>↓</kbd>       | Move to the previous / next visible row                 |
| <kbd>→</kbd>                      | Expand a collapsed collection, or step into an open one |
| <kbd>←</kbd>                      | Collapse an open collection, or jump to its parent      |
| <kbd>Home</kbd> / <kbd>End</kbd>  | Jump to the first / last visible row                    |
| _Type a name_                     | Type-ahead: jump to the next row that starts with it    |
| <kbd>⌘/Ctrl</kbd>+<kbd>F</kbd>    | Reveal the filter box above the list                    |
| <kbd>Esc</kbd>                    | Hide the filter box and clear the filter                |
| <kbd>Enter</kbd>                  | Open the request, or toggle the collection              |
| <kbd>Space</kbd>                  | Select the row without opening / toggling               |
| <kbd>⌘/Ctrl</kbd>+<kbd>D</kbd>    | Duplicate the focused request (requests only)           |
| <kbd>F2</kbd>                     | Rename the focused request or folder                    |
| <kbd>Del</kbd> / <kbd>⌫</kbd>     | Delete the focused request or folder (opens a confirm)  |

The same <kbd>↑</kbd> / <kbd>↓</kbd> / <kbd>Home</kbd> / <kbd>End</kbd> keys move
between entries in the collections and environments lists.

## Pickers & menus

Dropdown menus and selectors throughout the app are fully keyboard-operable:

| Shortcut                                         | Action                       |
| ------------------------------------------------ | ---------------------------- |
| <kbd>Enter</kbd> / <kbd>Space</kbd> / <kbd>↓</kbd>| Open the menu                |
| <kbd>↑</kbd> / <kbd>↓</kbd>                       | Move between options          |
| <kbd>Home</kbd> / <kbd>End</kbd>                 | First / last option          |
| <kbd>Enter</kbd> / <kbd>Space</kbd>              | Apply the highlighted option |
| <kbd>Esc</kbd>                                   | Close without changing       |

## Tree & dialogs

| Shortcut         | Action                                               |
| ---------------- | ---------------------------------------------------- |
| <kbd>Enter</kbd> | Confirm an inline rename                             |
| <kbd>Esc</kbd>   | Cancel a rename / close the current popup or dialog  |
| Double-click     | Rename a request, folder, collection, or environment |

## Accessibility

Rest Hippo respects your operating system's accessibility preferences automatically —
there's nothing to turn on in the app:

- **Reduce motion** — when your OS asks apps to minimize motion, Rest Hippo drops the
  slide-in, scale, and pulse animations on toasts, menus, and indicators
  (loading spinners keep turning, since the motion is the "in progress" signal).
- **Increased contrast / High Contrast** — muted secondary text is strengthened,
  and the focus ring and the current-selection outline stay visible (including in
  Windows High Contrast / forced-colors mode).

Every interactive control is reachable by keyboard and shows a focus ring when
focused that way. Icon-only buttons carry text labels for screen readers, and
status messages (errors, saves) are announced as they appear.

---

[← Back to contents](README.md)
