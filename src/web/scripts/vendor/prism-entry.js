/**
 * prism-entry.js — Prism.js bundle entry point
 *
 * Imports Prism core plus the language grammars needed by the response viewer:
 *   - markup     (XML + HTML; must come first — css/javascript extend it)
 *   - css
 *   - javascript
 *   - json
 *   - yaml
 *   - graphql   (GraphQL body mode — Feature 34)
 *
 * Prism is set to manual mode so it never auto-highlights the whole page;
 * response-viewer.js calls Prism.highlight() directly.
 *
 * This file is NOT imported at runtime — it is compiled by esbuild into
 *   web/scripts/vendor/prism.js
 * via the `vendor-prism` npm / make target.
 */

import Prism from "prismjs";
import "prismjs/components/prism-markup"; // XML + HTML (must come before css/javascript)
import "prismjs/components/prism-css";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-graphql";

Prism.manual = true; // disable auto-highlight on DOMContentLoaded

export default Prism;
export { Prism };
