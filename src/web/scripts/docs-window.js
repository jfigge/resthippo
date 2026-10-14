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
