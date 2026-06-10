/**
 * docs-window.js — Bootstrap for the standalone user-guide window (docs.html).
 *
 * Mounts the DocsViewer into the page and wires Escape to close the window. The
 * window is created in the main process (showDocsWindow in main.js) and is fully
 * independent of the main window, so the guide stays readable while the user
 * works in the app.
 */

"use strict";

import { DocsViewer } from "./components/docs-viewer.js";

const root = document.getElementById("docs-root");
new DocsViewer().mount(root);

// Escape closes the help window (Cmd/Ctrl+W is handled natively by the menu).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.close();
});
