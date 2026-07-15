# Feature 51 — Favorites / pinning & recents

## Context
There is no quick-access concept: searching the codebase for favorite/pin/star/bookmark/recent finds
nothing relevant ("pinned" refers only to layout). Navigation is entirely manual tree-hunting plus the
active-collection sidebar filter (`tree-view.js`). Per-request **run history** exists (the Timeline) but
that's execution history, not a navigation surface. Frequent-request access and a recents list are standard
aids in Postman/Insomnia.

## Goal
Let users favorite requests and see a recently-used list, surfaced for fast navigation (and feeding the
command palette).

## Implementation steps
1. **Model & store**: track a set of favorited request ids and a capped, ordered recents list (most-recent-
   first, deduped) in the settings/manifest store. Update recents whenever a request is opened or sent.
2. **Favorite affordance**: add a hollow / filled yellow star toggle in the tree context menu for a request 
   row; When favored, show a star indicator on favorited rows to the left of the method icon.name, but do not
   change the existing alignment of the indent for the row.
3. **Surfaces**: add a "Favorites" and "Recents" section at the top of the sidebar (collapsible) listing
   those requests across all collections, each opening/focusing the request. 
   Feed favorites/recents into the Feature 30 command palette ranking (recency boost).
4. **Lifecycle**: handle deletion/rename/move so favorites/recents don't dangle (drop missing ids).
5. **Visibility**: Although the most recently used list should always track the last 10 requests to be send, 
   visibility of the Recents tab should be controled by a settings under the appear table, allowing for the
   list to be turned off.  When disabled, the tab will not be shown
   When at least one request has been favorited for a selected collection, show the favorite tab.  Otherwise,
   if there are no favorites selectred the tab should be hidden.
   If either of the favorite or recent tabs are to be shown, reveal a tab bar at the top of the collections 
   tree-view to hold the [Requests | Favorites | Recent] tabs.  If neither favorite or recent are to be shown
   then hide the tab bar

## Acceptance criteria
- A request can be pinned/unpinned; favorited requests appear in a Favorites list spanning all collections.
- Opening/sending a request updates a deduped, capped Recents list, newest first.
- Both lists persist across restarts and survive rename/move; deleted requests drop out.
- Selecting from either list opens/focuses the request.
- If there are no favorites and the most recently used tab is disabled by settings, no tab-bar panel shoudl 
  be shown

## Constraints
- Reuse existing navigation events (`hippo:request-selected`) and the settings/manifest store.
- Plain DOM + class-based ES module; CSS tokens from `theme.css`, styles in `components.css`.
- Keep persisted settings additive/back-compatible.

## Verify
`make fmt && make lint && make test`
