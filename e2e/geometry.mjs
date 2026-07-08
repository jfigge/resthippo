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

// ── selection: a drag from the strip below the last line selects text ───────
// A PillCodeEditor's editing host (`.pce-doc`) is only as tall as its content,
// so in an embedded editor filling a pane (e.g. the pre-request script pane)
// the empty strip below the last line belongs to the non-editable container —
// a press there would start no caret and no drag-selection. The fix
// (PillCodeEditor #onContainerMouseDown) anchors the caret at the end of the
// last line and drives the drag itself. Real layout only: jsdom stubs
// getBoundingClientRect / caretRangeFromPoint to zero, so it can't be exercised
// in the unit harness.
spec(
  "geometry: dragging from below the last script line selects the text",
  async (h) => {
    await h.selectReq("GET", "List users");
    await h.reqTab("scripts");
    await h.waitForSel(".scripts-pane .pce-doc");

    // Seed one line of script in the pre-request pane (its editor is the first
    // .scripts-pane's .pce-doc), leaving empty space below it in the tall pane.
    await h.focusSel(".scripts-pane .pce-doc");
    await h.dispatchKey("a", "KeyA", 65, 4 /* Meta = select-all */);
    await h.insertText("const answer = 42;");
    await h.waitForText(".scripts-pane .pce-doc", "answer");

    const g = await h.cdp.eval(`(()=>{
      const pane = document.querySelector('.scripts-pane');
      const pce = pane.querySelector('.pce');
      const doc = pane.querySelector('.pce-doc');
      const lines = [...doc.querySelectorAll('.pce-line')];
      const last = lines[lines.length - 1];
      const pceR = pce.getBoundingClientRect();
      const docR = doc.getBoundingClientRect();
      const lastR = last.getBoundingClientRect();
      const deadZone = pceR.bottom - lastR.bottom;
      return {
        deadZone,
        x: docR.left + 40,                       // past the gutter + left padding
        deadY: lastR.bottom + Math.min(16, deadZone / 2),
        textY: lastR.top + lastR.height / 2,
      };
    })()`);

    assert.ok(
      g.deadZone > 20,
      `the pane leaves an empty strip below the last line (${g.deadZone}px) to press in`,
    );

    // Real press in the dead zone → drag straight up into the line → release.
    const mouse = (type, x, y, buttons) =>
      h.cdp.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: type === "mouseMoved" ? 0 : 1,
        buttons,
      });
    await mouse("mousePressed", g.x, g.deadY, 1);
    await mouse("mouseMoved", g.x, g.textY, 1);
    await mouse("mouseReleased", g.x, g.textY, 0);

    const sel = await h.cdp.eval(`(()=>{
      const s = window.getSelection();
      const doc = document.querySelector('.scripts-pane .pce-doc');
      return {
        text: s.toString(),
        collapsed: s.isCollapsed,
        anchorIn: doc.contains(s.anchorNode),
        focusIn: doc.contains(s.focusNode),
      };
    })()`);

    assert.ok(
      !sel.collapsed,
      "the press-and-drag from the dead zone produced a non-collapsed selection",
    );
    assert.ok(
      sel.text.length > 0,
      `the selection covers script text (got "${sel.text}")`,
    );
    assert.ok(
      sel.anchorIn && sel.focusIn,
      "the selection stays anchored inside the pre-request editor",
    );
  },
);
