# Keyboard Shortcuts

[← Back to contents](README.md)

> On macOS use <kbd>⌘</kbd> (Command); on Windows/Linux use <kbd>Ctrl</kbd>.

## Sending requests

| Shortcut                           | Action                                          |
| ---------------------------------- | ----------------------------------------------- |
| <kbd>Enter</kbd>                   | Send the request (while the URL bar is focused) |
| <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> | Send a WebSocket message (while connected)      |

## Response viewer

| Shortcut                          | Action                           |
| --------------------------------- | -------------------------------- |
| <kbd>⌘/Ctrl</kbd>+<kbd>F</kbd>    | Open the find-in-response bar    |
| <kbd>Enter</kbd>                  | Next match (in the find bar)     |
| <kbd>Shift</kbd>+<kbd>Enter</kbd> | Previous match (in the find bar) |
| <kbd>⌘/Ctrl</kbd>+<kbd>A</kbd>    | Select the entire response body  |
| <kbd>Esc</kbd>                    | Close the find bar               |

## Editors & typeahead

| Shortcut                          | Action                                |
| --------------------------------- | ------------------------------------- |
| `{{`                              | Open the variable typeahead           |
| <kbd>↑</kbd> / <kbd>↓</kbd>       | Move through autocomplete suggestions |
| <kbd>Enter</kbd> / <kbd>Tab</kbd> | Accept the highlighted suggestion     |
| <kbd>Esc</kbd>                    | Dismiss suggestions                   |

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
| <kbd>Enter</kbd>                  | Open the request, or toggle the collection              |
| <kbd>Space</kbd>                  | Select the row without opening / toggling               |

The same <kbd>↑</kbd> / <kbd>↓</kbd> / <kbd>Home</kbd> / <kbd>End</kbd> keys move
between entries in the collections and environments lists.

## Pickers & menus

The layout picker (and other dropdown menus) are fully keyboard-operable:

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

wurl respects your operating system's accessibility preferences automatically —
there's nothing to turn on in the app:

- **Reduce motion** — when your OS asks apps to minimize motion, wurl drops the
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
