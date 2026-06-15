/**
 * prism-entry.js — Prism.js bundle entry point
 *
 * Imports Prism core plus the language grammars needed by the response viewer
 * and the "Generate code" dialog (Feature 38):
 *   - markup     (XML + HTML; must come first — css/javascript extend it)
 *   - css
 *   - javascript (fetch code-gen target)
 *   - json
 *   - yaml
 *   - graphql   (GraphQL body mode — Feature 34)
 *   - bash      (cURL + HTTPie code-gen targets — Feature 38)
 *   - python    (requests code-gen target — Feature 38)
 *   - go        (net/http code-gen target — Feature 38)
 *
 * Prism is set to manual mode so it never auto-highlights the whole page;
 * response-viewer.js and code-gen-modal.js call Prism.highlight() directly.
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
import "prismjs/components/prism-bash"; // cURL + HTTPie code-gen targets
import "prismjs/components/prism-python"; // requests code-gen target
import "prismjs/components/prism-go"; // net/http code-gen target

Prism.manual = true; // disable auto-highlight on DOMContentLoaded

export default Prism;
export { Prism };
