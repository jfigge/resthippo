/**
 * prism-entry.js — Prism.js bundle entry point
 *
 * Imports Prism core plus the language grammars needed by the response viewer:
 *   - markup  (XML + HTML)
 *   - json
 *   - yaml
 *
 * Prism is set to manual mode so it never auto-highlights the whole page;
 * response-viewer.js calls Prism.highlight() directly.
 *
 * This file is NOT imported at runtime — it is compiled by esbuild into
 *   web/scripts/vendor/prism.js
 * via the `vendor-prism` npm / make target.
 */

import Prism from "prismjs";
import "prismjs/components/prism-markup"; // XML + HTML (must come before JSON/YAML)
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";

Prism.manual = true; // disable auto-highlight on DOMContentLoaded

export default Prism;
export { Prism };
