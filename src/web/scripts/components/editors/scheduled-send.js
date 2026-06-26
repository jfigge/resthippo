/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * editors/scheduled-send.js — the Send button's scheduled-send state machine.
 *
 * Extracted verbatim (behaviour-preserving) from RequestEditor. Owns the active
 * send type (immediate / delayed / interval), the two durations, and the live
 * countdown schedule + its timers; the host (RequestEditor) owns the DOM. The
 * three modes:
 *   • immediate — fire now
 *   • delayed   — wait the delay, fire once
 *   • interval  — wait the interval, fire, then re-arm once the request settles
 * The countdown is cancellable and paints a colour sweep onto the Send button via
 * requestAnimationFrame. Behaviour is pinned by tests/scheduled-send.test.js.
 *
 * Host interface (all read live, so RequestEditor field reassignments are safe):
 *   getCurrentNodeId()  → the loaded request's id (schedules belong to a request)
 *   getUrlValue()       → current URL text (the empty-URL guard before arming)
 *   focusUrl()          → focus the URL field (when arming a blank request)
 *   fire(force)         → dispatch the actual send (force skips the var prompt)
 *   getSendButton()     → the Send button element, for the sweep paint (or null)
 *   onStateChange()     → re-sync the Send button (host's #applySendButtonState)
 *   persistSetting(d)   → persist a send-type/duration setting globally
 */
"use strict";

export class ScheduledSend {
  #host;
  #type = "immediate";
  #delayMs = 5000;
  #intervalMs = 10000;
  // The live schedule: { requestId, type, phase: "counting"|"firing", durationMs,
  // startTs, timerId, rafId } — null when nothing is scheduled.
  #schedule = null;

  constructor(host) {
    this.#host = host;
  }

  get type() {
    return this.#type;
  }
  get delayMs() {
    return this.#delayMs;
  }
  get intervalMs() {
    return this.#intervalMs;
  }

  /**
   * Apply persisted send settings. Returns true when the active type changed (so
   * the host can refresh the idle button glyph only when something changed).
   */
  applySettings(settings) {
    let typeChanged = false;
    if (settings.sendType != null && settings.sendType !== this.#type) {
      this.#type = settings.sendType;
      typeChanged = true;
    }
    if (settings.sendDelayMs != null)
      this.#delayMs = Math.max(250, settings.sendDelayMs);
    if (settings.sendIntervalMs != null)
      this.#intervalMs = Math.max(250, settings.sendIntervalMs);
    return typeChanged;
  }

  /** Reset the type to immediate (on request switch). Returns true if it changed. */
  resetType() {
    if (this.#type === "immediate") return false;
    this.#type = "immediate";
    return true;
  }

  /** Set the active type (persisted globally) and refresh the button. */
  setType(type) {
    if (type === this.#type) return;
    this.#type = type;
    this.#host.persistSetting({ sendType: type });
    this.#host.onStateChange();
  }

  /** Set a send duration (ms), clamped to a sane floor, and persist it. */
  setDuration(key, ms) {
    const clamped = Math.max(250, ms || 0);
    if (key === "sendIntervalMs") this.#intervalMs = clamped;
    else this.#delayMs = clamped;
    this.#host.persistSetting({ [key]: clamped });
  }

  /** Icon-registry name for the active send type, or null for immediate. */
  iconName() {
    if (this.#type === "delayed") return "sendDelayed";
    if (this.#type === "interval") return "sendInterval";
    return null;
  }

  /** True when a countdown is actively counting for the loaded request. */
  isCountingForLoaded() {
    return (
      this.#schedule != null &&
      this.#schedule.phase === "counting" &&
      this.#schedule.requestId === this.#host.getCurrentNodeId()
    );
  }

  /**
   * Entry point for a Send trigger (click, ⌘/Ctrl+Enter, or tree double-click).
   * Dispatches by the active type: fire now, or start a cancellable countdown.
   */
  execute() {
    if (this.#type === "immediate") {
      this.#host.fire(false);
      return;
    }
    // Delayed / interval both need a URL before arming a timer — mirror the
    // empty-URL guard in the host's send so a blank request just focuses the field.
    if (!this.#host.getUrlValue().trim()) {
      this.#host.focusUrl();
      return;
    }
    this.#start(this.#type);
  }

  /**
   * Cancel a counting-down schedule and restore the idle Send button. Used by a
   * "Cancel" click and on request switch. Safe to call with no active schedule.
   */
  cancel() {
    this.clear();
    this.#host.onStateChange();
  }

  /** Tear down any schedule's timers without touching the button. */
  clear() {
    const s = this.#schedule;
    if (!s) return;
    if (s.timerId != null) clearTimeout(s.timerId);
    if (s.rafId != null) cancelAnimationFrame(s.rafId);
    this.#schedule = null;
  }

  /** Restart an interval's wait after the fired request completes. */
  maybeRestartInterval(requestId) {
    const s = this.#schedule;
    if (
      !s ||
      s.type !== "interval" ||
      s.phase !== "firing" ||
      s.requestId !== requestId
    )
      return;
    // Only re-arm while the interval's request is still the one on screen.
    if (requestId !== this.#host.getCurrentNodeId()) {
      this.clear();
      return;
    }
    this.#start("interval");
  }

  /**
   * Arm a countdown for the loaded request. On expiry the request fires; an
   * interval re-arms on completion (see maybeRestartInterval). The colour sweep
   * is animated by #tickSweep via requestAnimationFrame.
   */
  #start(type) {
    this.cancel(); // never run two timers at once
    const requestId = this.#host.getCurrentNodeId() ?? null;
    const durationMs = type === "interval" ? this.#intervalMs : this.#delayMs;
    const schedule = {
      requestId,
      type,
      phase: "counting",
      durationMs,
      startTs: performance.now(),
      timerId: null,
      rafId: null,
    };
    schedule.timerId = setTimeout(() => this.#onScheduleFire(), durationMs);
    this.#schedule = schedule;
    this.#host.onStateChange();
    this.#tickSweep();
  }

  /** Animation frame: paint the countdown sweep (elapsed fraction, hard edge). */
  #tickSweep() {
    const s = this.#schedule;
    if (!s || s.phase !== "counting") return;
    // Only paint while this schedule's request is the one on screen.
    if (s.requestId === this.#host.getCurrentNodeId()) {
      const btn = this.#host.getSendButton();
      if (btn) {
        const elapsed = (performance.now() - s.startTs) / s.durationMs;
        const frac = Math.max(0, Math.min(1, elapsed));
        btn.style.setProperty("--send-sweep", `${(frac * 100).toFixed(2)}%`);
      }
    }
    s.rafId = requestAnimationFrame(() => this.#tickSweep());
  }

  /** The countdown reached zero: fire the request (interval keeps the schedule). */
  #onScheduleFire() {
    const s = this.#schedule;
    if (!s) return;
    if (s.rafId != null) cancelAnimationFrame(s.rafId);
    s.rafId = null;
    s.timerId = null;
    // A request whose URL was cleared mid-countdown can't fire — drop the loop.
    if (!this.#host.getUrlValue().trim()) {
      this.clear();
      return;
    }
    if (s.type === "interval") {
      // Keep the schedule across the in-flight phase so completion can re-arm it.
      s.phase = "firing";
    } else {
      // One-shot: the schedule is done once the send is dispatched.
      this.#schedule = null;
    }
    this.#host.onStateChange();
    // Timer-driven sends skip the interactive unresolved-variable prompt so a
    // loop never blocks on a modal (force=true).
    this.#host.fire(true);
  }
}
