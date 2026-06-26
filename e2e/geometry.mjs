// geometry.mjs — Real-layout (geometry) end-to-end specs for Rest Hippo.
//
// These cover the pixel/layout math the jsdom unit harness CANNOT exercise:
// jsdom stubs getClientRects / getBoundingClientRect / scrollIntoView to zero
// (src/web/scripts/tests/jsdom-setup.js), so caret coordinates, drag drop-ratios
// and overlay bounds are untestable there. Here we drive the REAL Electron
// renderer over CDP — same transport as specs.mjs — so layout is real and these
// assert the parts the jsdom seam tests deliberately leave uncovered:
//
//   • drag-drop  — a real row rect → ratio → drop position (pairs with the pure
//                  computeDropPos truth table in components/tests/drag-drop.test.js)
//   • caret      — the {{ pill picker anchors at the real caret rect (pairs with
//                  the offset-math tests in scripts/tests/pill-caret.test.js)
//   • overlay    — the HTML-preview overlay bounds equal the real preview pane
//                  rect (pairs with the popup-depth tests in response-overlay.test.js)
//
// They share the launch / seed / teardown of run.mjs and are selected by name:
//   make test-geometry            (→ node e2e/run.mjs geometry)
// They need a display + Electron + the mock API, so — like the rest of e2e —
// they are NOT part of the hermetic `make test` gate.
import assert from "node:assert/strict";

export const geometrySpecs = [];
const spec = (name, fn) => geometrySpecs.push({ name, fn });

// ── drag-drop: real row rect → ratio → drop position ────────────────────────
// jsdom returns height 0, so its ratio is NaN and drop-position is untestable.
// Here the row has a real height: a dragover in the top half drops "before", the
// bottom half "after" — the geometry→ratio→computeDropPos pipeline end to end.
spec("geometry: drag drop-position follows the real row rect", async (h) => {
  const r = await h.cdp.eval(`(async () => {
    const reqRows = [...document.querySelectorAll('.tree-node-row')]
      .filter(row => row.querySelector('.tree-node-method'));
    if (reqRows.length < 2) return { error: 'need two visible request rows' };
    const dragged = reqRows[0], target = reqRows[1];
    const dt = new DataTransfer();
    dragged.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    // The phantom mounts on the next frame (see TreeView #attachDragListeners).
    await new Promise(res => requestAnimationFrame(() => res()));
    const phantomMounted = !!document.querySelector('.tree-drop-phantom');
    const rect = target.getBoundingClientRect();
    const posAt = (ratio) => {
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true,
        clientX: rect.left + 4, clientY: rect.top + rect.height * ratio,
        dataTransfer: dt,
      }));
      return document.querySelector('.tree-drop-phantom')?.dataset.targetPos ?? null;
    };
    const top = posAt(0.1);
    const bottom = posAt(0.9);
    dragged.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return { height: rect.height, phantomMounted, top, bottom };
  })()`);

  assert.ok(!r.error, r.error);
  assert.ok(r.height > 0, "real row has a non-zero height (jsdom stubs it to 0)");
  assert.ok(r.phantomMounted, "drag phantom mounted on dragstart");
  assert.equal(r.top, "before", "top of the row → drop before");
  assert.equal(r.bottom, "after", "bottom of the row → drop after");
});

// ── caret: the {{ pill picker anchors at the real caret rect ────────────────
// caretCoords() reads Range.getClientRects() — all zero under jsdom, so the
// picker anchoring can only be verified against real layout.
spec("geometry: the {{ picker anchors at the real caret position", async (h) => {
  await h.selectReq("GET", "List users");
  await h.waitForSel(".req-url-input");

  // Caret at the end of the URL editor; capture its real viewport rect.
  const caret = await h.cdp.eval(`(()=>{
    const el = document.querySelector('.req-url-input'); el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    const cr = r.getBoundingClientRect();
    return { left: cr.left, top: cr.top, bottom: cr.bottom, height: cr.height };
  })()`);
  assert.ok(
    caret.height > 0 || caret.bottom > caret.top,
    "real caret rect has height (jsdom stubs it to 0)",
  );

  await h.insertText("{{");
  await h.waitForSel(".pill-picker");
  const picker = await h.cdp.eval(`(()=>{
    const r = document.querySelector('.pill-picker').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  })()`);

  assert.ok(picker.width > 0 && picker.height > 0, "picker has real layout size");
  assert.ok(picker.top > 0, "picker is positioned (not at the 0,0 jsdom origin)");
  assert.ok(
    Math.abs(picker.left - caret.left) < 80,
    `picker left (${picker.left}) anchors near the caret left (${caret.left})`,
  );
  await h.escape();
});

// ── overlay: HTML-preview bounds equal the real preview pane rect ───────────
// #computeBounds rounds previewPane.getBoundingClientRect(); we record what the
// viewer passes to the native preview bridge and compare to the real pane rect.
spec("geometry: HTML preview overlay bounds match the real preview pane", async (h) => {
  // Record (and neutralise) the native preview bridge BEFORE activating it, so
  // no real WebContentsView is created and we capture the computed bounds.
  const installed = await h.cdp.eval(`(()=>{
    const html = window.hippo && window.hippo.preview && window.hippo.preview.html;
    if (!html) return false;
    window.__pv = [];
    for (const m of ['loadUrl','show','resize','hide','destroy']) {
      html[m] = (...a) => {
        window.__pv.push({ m, bounds: a.find(x => x && typeof x === 'object' && 'width' in x) || null });
        return Promise.resolve();
      };
    }
    return true;
  })()`);
  assert.ok(installed, "preview bridge present to instrument");

  await h.selectReqByName("HTML page");
  await h.waitForText(".req-url-input", "/mimes/text/html");
  const resp = await h.send();
  assert.equal(resp.status, 200, "HTML page returns 200");

  // The Preview tab is revealed for HTML responses; switch to it to activate.
  await h.waitFor(
    `(()=>{const b=document.querySelector('.res-tab-btn[data-tab="preview"]');return b && !b.hidden})()`,
    { label: "Preview tab visible for HTML response" },
  );
  await h.resTab("preview");

  await h.waitFor(`window.__pv && window.__pv.some(e => e.bounds)`, {
    label: "preview overlay bounds recorded",
  });

  const cmp = await h.cdp.eval(`(()=>{
    const r = document.querySelector('#res-tab-preview').getBoundingClientRect();
    const rec = [...window.__pv].reverse().find(e => e.bounds)?.bounds;
    return {
      pane: { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) },
      rec,
    };
  })()`);

  assert.ok(cmp.rec, "a bounds object was passed to the preview bridge");
  assert.ok(
    cmp.pane.w > 1 && cmp.pane.h > 1,
    "real preview pane has a non-zero rect (jsdom stubs it to 0)",
  );
  assert.ok(
    Math.abs(cmp.rec.width - cmp.pane.w) <= 2,
    `overlay width (${cmp.rec.width}) ≈ pane width (${cmp.pane.w})`,
  );
  assert.ok(
    Math.abs(cmp.rec.height - cmp.pane.h) <= 2,
    `overlay height (${cmp.rec.height}) ≈ pane height (${cmp.pane.h})`,
  );
});
