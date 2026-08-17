/**
 * trace.mjs — the motion debugging harness, ported from prototype-v3-trace.html.
 *
 * WHY THIS IS IN THE SHIPPING APP and not a disposable HTML file.
 * `CLAUDE.md` says gesture debugging belongs in "a disposable harness importing
 * gesture-arbiter.mjs — no build step, no other variables." That is right for logic
 * bugs in the arbiter. It is WRONG for the two defects in `motion-fork-brief.md`:
 *
 *   · Both were observed on the BUILT site, on real hardware, on two engines.
 *   · `prototype-v3-trace.html` carries the v3-era arbiter, opened from disk, with no
 *     minifier in the path. That is precisely the gap the `500ms` -> `.5s` bug lived in
 *     for a week: the prototype was right and the build was wrong.
 *
 * So the harness follows the code. Inert unless `?trace=1` is in the URL: `createTrace`
 * returns an object whose methods are empty functions, and the only cost on the hot path
 * is a call that returns immediately.
 *
 *   /?trace=1     arm it        D  dump the report to the console
 *                               C  clear the buffer and counters
 *
 * ⚠︎ READ THIS BEFORE TRUSTING A ZERO.
 * `hooks.md` and the fork brief both define Q4 as "card->landing hops WITHIN ONE
 * GESTURE". That definition cannot see defect B. B's whole mechanism is that momentum
 * MINTS A FRESH GESTURE — so the hop lands under a NEW gestureId and a same-gesture
 * counter reads 0 while the bug is live. That is the same trap the brief warns about for
 * the card->carousel counter ("you will tune against a metric that reads 0 while the bug
 * is live"), one level deeper.
 *
 * So every leak is counted TWICE and reported side by side:
 *   SAME-GESTURE  the historical definition. Kept so old numbers stay comparable.
 *   POST-CLOSE    anything the deck or a transition did within `window` ms of a close,
 *                 regardless of gestureId. ⭐ THIS is the one that catches B.
 */

/** Percentile of a sorted-in-place copy. */
function pct(arr, p) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

const fmt = (n) => (Number.isFinite(n) ? +n.toFixed(2) : n);

export const TRACE_DEFAULTS = Object.freeze({
  max: 8000,        // ring-buffer ceiling; a hard flick is ~40 events
  window: 1200,     // ms after a close that still counts as "post-close"
});

/**
 * @param {boolean} enabled
 * @param {object}  opts   overrides for TRACE_DEFAULTS
 * @returns {{on:boolean, push:Function, wheel:Function, report:Function, clear:Function, bind:Function}}
 */
export function createTrace(enabled, opts = {}) {
  if (!enabled) {
    const noop = () => {};
    return { on: false, push: noop, wheel: noop, report: noop, clear: noop, bind: noop };
  }

  const C = { ...TRACE_DEFAULTS, ...opts };
  const rows = [];
  let seq = 0;
  let hudEl = null;

  // ---- what this ENGINE exposes, decided once, from the prototype rather than from a
  // sample. An engine that supports `momentum` but happens to receive no inertial events
  // during a capture must still report "supported" — otherwise B's feature detect and the
  // trace would disagree about the same browser.
  const supports = {
    momentum: typeof WheelEvent !== "undefined" && "momentum" in WheelEvent.prototype,
    momentumPhase: typeof WheelEvent !== "undefined" && "momentumPhase" in WheelEvent.prototype,
    phase: typeof WheelEvent !== "undefined" && "phase" in WheelEvent.prototype,
  };
  // every distinct value actually OBSERVED, per property. Safari's phases are strings
  // ("began"/"changed"/"ended"); Chrome's momentum is a boolean. Recording the raw values
  // is the point — the brief says to verify semantics in a real browser before building
  // on them, and this is that verification.
  const seen = { momentum: new Set(), momentumPhase: new Set(), phase: new Set() };

  // ⚠︎ `X in WheelEvent.prototype` finds standard, prototype-installed properties. It does
  // NOT find a property an engine hangs on the event INSTANCE, which is how legacy WebKit
  // extensions have historically been shipped. The 2026-08-17 Safari capture reported
  // momentum/momentumPhase/phase all false — that may be the truth, or it may be this
  // detection looking in the wrong place. So on the first event, enumerate everything the
  // object actually has and subtract the known-standard names. Whatever is left is what
  // this engine offers, under whatever name it chose. Runs once.
  const KNOWN = new Set([
    "deltaX", "deltaY", "deltaZ", "deltaMode", "DOM_DELTA_PIXEL", "DOM_DELTA_LINE",
    "DOM_DELTA_PAGE", "screenX", "screenY", "clientX", "clientY", "layerX", "layerY",
    "offsetX", "offsetY", "pageX", "pageY", "x", "y", "movementX", "movementY", "button",
    "buttons", "relatedTarget", "ctrlKey", "shiftKey", "altKey", "metaKey", "getModifierState",
    "initMouseEvent", "initUIEvent", "initWheelEvent", "view", "detail", "which", "sourceCapabilities",
    "type", "target", "currentTarget", "eventPhase", "bubbles", "cancelable", "defaultPrevented",
    "composed", "isTrusted", "timeStamp", "srcElement", "returnValue", "cancelBubble",
    "composedPath", "stopPropagation", "stopImmediatePropagation", "preventDefault",
    "initEvent", "NONE", "CAPTURING_PHASE", "AT_TARGET", "BUBBLING_PHASE",
    "wheelDelta", "wheelDeltaX", "wheelDeltaY",
  ]);
  let nonStandard = null;          // filled from the first real event
  function probeOnce(e) {
    if (nonStandard) return;
    nonStandard = {};
    for (let o = e; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) {
        if (KNOWN.has(k) || k.startsWith("__")) continue;
        let v; try { v = e[k]; } catch { continue; }
        if (typeof v === "function") continue;
        nonStandard[k] = v;
      }
    }
  }

  /**
   * Is this event the USER, or the platform coasting?
   * @returns {true|false|null}  null = this engine exposes nothing and cannot say.
   *
   * ⚠︎ Returning `null` rather than guessing is the whole point. The first version of this
   * file asked `e.momentum === false`, which on WebKit is `undefined === false` — always
   * false — so every WebKit event read as inertia and the leak counter ran away. An engine
   * that cannot answer must SAY SO; the report then marks its counts unreliable instead of
   * printing a confident wrong number.
   */
  const idle = (v) => v === undefined || v === null || v === "none" || v === 0 || v === "";
  function deliberate(e) {
    if (supports.momentum) return e.momentum === false;
    // WebKit: momentumPhase is "began"/"changed"/"ended" (or a small integer) while coasting,
    // and "none"/0 during real finger contact. ⚠︎ VERIFY THE VALUES IN Q0 BEFORE TRUSTING —
    // this property is non-standard and undocumented by Apple for the web.
    if (supports.momentumPhase) return idle(e.momentumPhase);
    return null;
  }

  const push = (o) => {
    if (rows.length < C.max) rows.push({ i: seq++, t: Math.round(performance.now()), ...o });
    schedulePaint();
  };

  // ⚠︎ THE INSTRUMENT MUST NOT PERTURB WHAT IT MEASURES. counts() is a full pass over the
  // buffer; painting the HUD from inside push() made it O(n^2) across a capture, which on a
  // hard flick is real work landing in the exact frames whose timing is under test. Coalesce
  // to one repaint per frame — the HUD is a comfort, the numbers come from data()/report().
  let paintQueued = false;
  function schedulePaint() {
    if (paintQueued || !hudEl) return;
    paintQueued = true;
    requestAnimationFrame(() => { paintQueued = false; paint(); });
  }

  /**
   * One wheel event, with the arbiter's state on both sides of `feed()`.
   * @param {WheelEvent} e
   * @param {number} dt
   * @param {object} before  arb.state() BEFORE feed
   * @param {object} after   arb.state() AFTER feed
   */
  const wheel = (e, dt, before, after) => {
    probeOnce(e);
    for (const k of ["momentum", "momentumPhase", "phase"]) {
      if (e[k] !== undefined) seen[k].add(String(e[k]));
    }
    push({
      k: "wheel",
      dt: fmt(dt),
      dx: fmt(e.deltaX),
      dy: fmt(e.deltaY),
      y: Math.round(e.clientY),
      mom: e.momentum,                 // Chrome 151+
      mPhase: e.momentumPhase,         // WebKit
      phase: e.phase,                  // WebKit
      g: after.gestureId,
      claim: after.gRegion,
      spent: after.spentOn,
      // ⭐ the mint, observed from OUTSIDE the module. The arbiter is a black box here;
      // a change in gestureId across feed() is a new gesture, by definition.
      minted: after.gestureId !== before.gestureId,
      peak: fmt(after.peak),
      // true = user, false = inertia, null = this engine cannot say. Classified HERE, at
      // capture time, because only here is the live event available.
      deliberate: deliberate(e),
    });
  };

  // ---- HUD ------------------------------------------------------------------
  function paint() {
    if (!hudEl) return;
    const c = counts();
    hudEl.textContent =
      `trace ${rows.length}   post-close leaks ${c.postClose.total}` +
      `   (deck ${c.postClose.deck} · tab ${c.postClose.tab} · landing ${c.postClose.landing})` +
      `   same-gesture ${c.sameGesture.total}   D=dump  C=clear`;
  }

  function bind() {
    hudEl = document.createElement("div");
    hudEl.setAttribute("style",
      "position:fixed;left:0;right:0;bottom:0;z-index:99999;font:11px/1.6 ui-monospace,monospace;" +
      "background:#000;color:#0f0;padding:4px 8px;pointer-events:none;white-space:pre");
    document.body.appendChild(hudEl);
    paint();
    addEventListener("keydown", (ev) => {
      const k = ev.key.toLowerCase();
      if (k === "d") report();
      if (k === "c") clear();
    });
    paint();
    // ⭐ the whole API on `window`, so a headless probe can ASSERT on the counters instead
    // of scraping console output. This is what makes the leak a regression test rather
    // than a thing someone has to notice by eye.
    window.__trace = api;
    // eslint-disable-next-line no-console
    console.log(
      "%ctrace armed%c  D = dump report   C = clear\n" +
      `engine exposes: momentum=${supports.momentum}  momentumPhase=${supports.momentumPhase}  phase=${supports.phase}`,
      "background:#0f0;color:#000;font-weight:bold", "");
  }

  const clear = () => { rows.length = 0; seq = 0; for (const s of Object.values(seen)) s.clear(); schedulePaint(); return "cleared"; };

  // ---- the counters ---------------------------------------------------------
  // A "leak" is the deck moving, or a transition committing, AFTER the card began
  // closing — with no deliberate new input in between.
  const isLeaky = (r) => r.k === ">DECK" || r.k === "@goTab" || r.k === "@goLanding";
  const bucket = (r) => (r.k === ">DECK" ? "deck" : r.k === "@goTab" ? "tab" : "landing");

  function counts() {
    const sameGesture = { total: 0, deck: 0, tab: 0, landing: 0, rows: [] };
    const postClose = { total: 0, deck: 0, tab: 0, landing: 0, rows: [] };
    // ⭐ THE OTHER FAILURE MODE, which had no counter at all in the first version. On an
    // engine whose inertial stream never pauses, the post-close gesture never ENDS — it
    // stays spent (no transition) and claimed "detail" (no deck), and every event lands on
    // it, INCLUDING the user's genuine next swipe. Nothing leaks; everything jams.
    const jam = { spans: 0, events: 0, swallowed: 0, longestMs: 0, rows: [] };

    let close = null;         // the most recent @closeDetail
    let span = null;          // the jam currently accumulating under it
    const endSpan = () => {
      if (span && span.events) {
        jam.spans++; jam.events += span.events; jam.swallowed += span.swallowed;
        jam.longestMs = Math.max(jam.longestMs, span.ms);
        jam.rows.push(span);
      }
      span = null;
    };

    for (const r of rows) {
      if (r.k === "@closeDetail") {
        endSpan();
        close = r;
        span = { closeG: r.g, events: 0, swallowed: 0, ms: 0, deliberateKnown: true };
        continue;
      }
      if (!close) continue;

      // ---- the jam side: an event that hit a spent, detail-claimed gesture and produced
      // nothing. `spent === g` means this gesture has no transition left; `claim==="detail"`
      // means it has no deck either. Together: this event could not do anything at all.
      if (r.k === "wheel" && span && r.g === close.g && r.spent === r.g && r.claim === "detail") {
        span.events++;
        span.ms = r.t - close.t;
        if (r.deliberate === true) span.swallowed++;      // ⭐ a REAL user push, ignored
        else if (r.deliberate === null) span.deliberateKnown = false;
      }

      // ---- a DELIBERATE event ends the post-close window: whatever happens next is
      // something the user asked for.
      // ⚠︎ THIS WAS ENGINE-DEPENDENTLY BROKEN. It tested `r.mom === false`, and on WebKit
      // `momentum` is undefined — never `false` — so the window never closed on real input
      // and every event within `window` ms of a close was counted as a leak. Safari's
      // numbers from the 2026-08-16 capture are inflated for exactly this reason. Now the
      // classification is computed per-engine at capture time, and `null` (engine cannot
      // say) is reported rather than silently treated as inertia.
      if (r.k === "wheel" && r.deliberate === true) { endSpan(); close = null; continue; }

      if (!isLeaky(r)) continue;
      const gap = r.t - close.t;
      if (gap > C.window) { endSpan(); close = null; continue; }

      const b = bucket(r);
      const rec = { ...r, gapMs: gap, closeG: close.g, sameGesture: r.g === close.g };
      postClose.total++; postClose[b]++; postClose.rows.push(rec);
      if (r.g === close.g) { sameGesture.total++; sameGesture[b]++; sameGesture.rows.push(rec); }
    }
    endSpan();
    // can this capture distinguish user input from inertia at all?
    const reliable = supports.momentum || supports.momentumPhase || supports.phase;
    return { sameGesture, postClose, jam, reliable };
  }

  function report() {
    const wheels = rows.filter((r) => r.k === "wheel");
    const c = counts();
    const ok = (n) => (n ? "color:#c00;font-weight:bold" : "color:#0a0;font-weight:bold");
    const L = (...a) => console.log(...a);   // eslint-disable-line no-console

    L(`%c=== TRACE — ${rows.length} samples, ${wheels.length} wheel events ===`, "font-weight:bold");

    // ---- Q0: does this engine expose the signal B is built on? ----
    L("%cQ0 MOMENTUM SIGNAL — the API defect B depends on", "font-weight:bold");
    console.table([{
      "WheelEvent.momentum": supports.momentum,
      "WheelEvent.momentumPhase": supports.momentumPhase,
      "WheelEvent.phase": supports.phase,
      "values seen (momentum)": [...seen.momentum].join(",") || "—",
      "values seen (momentumPhase)": [...seen.momentumPhase].join(",") || "—",
      "values seen (phase)": [...seen.phase].join(",") || "—",
      "events flagged momentum:true": wheels.filter((r) => r.mom === true).length,
      "events flagged momentum:false": wheels.filter((r) => r.mom === false).length,
    }]);
    if (!supports.momentum && !supports.momentumPhase) {
      L("%c  ⚠︎ this engine exposes NEITHER — it takes the LEGACY path. Behaviour must be unchanged here.", "color:#c60");
      L("%c  Every NON-STANDARD property found on a real event from this engine, in case the\n" +
        "  signal exists under a name nobody documented:", "font-weight:bold");
      console.table([nonStandard && Object.keys(nonStandard).length ? nonStandard : { "(none found)": true }]);
    }

    if (!c.reliable) {
      L("%c  ⛔ THIS ENGINE EXPOSES NEITHER SIGNAL. Every count below is UNRELIABLE: the trace\n" +
        "     cannot tell your swipe from the platform coasting, so the post-close window\n" +
        "     never closes on real input and leaks over-count. Treat as qualitative only.",
        "color:#c00;font-weight:bold");
    }

    // ---- ⭐ THE JAM: the opposite failure, and the one with no counter until now ----
    L("%cQ9 JAM — input SWALLOWED after a card close", "font-weight:bold");
    L(`%c  jammed spans ${c.jam.spans}   events absorbed ${c.jam.events}   longest ${c.jam.longestMs}ms` +
      `   confirmed user pushes ignored: ${c.jam.rows.every((s) => s.deliberateKnown) ? c.jam.swallowed : "unknown (engine cannot say)"}`,
      ok(c.jam.events));
    L("%c  A spent, \"detail\"-claimed gesture has NO transition and NO deck. On an engine whose\n" +
      "  inertial stream never pauses, it never ends — so every event lands on it and does\n" +
      "  nothing, INCLUDING your genuine next swipe. Nothing leaks; everything jams.", "color:#666");
    if (c.jam.rows.length) console.table(c.jam.rows);

    // ---- the leak counters ----
    L("%cQ4/Q6 LEAKS AFTER A CARD CLOSE — two definitions, deliberately", "font-weight:bold");
    L(`%c  POST-CLOSE (<=${C.window}ms, any gestureId) : ${c.postClose.total}` +
      `   deck ${c.postClose.deck} · tab ${c.postClose.tab} · landing ${c.postClose.landing}`,
      ok(c.postClose.total));
    L("%c  ⭐ this is the number that catches B. A leak under a NEWLY MINTED gesture is the bug.", "color:#666");
    L(`%c  SAME-GESTURE (the historical Q4)        : ${c.sameGesture.total}` +
      `   deck ${c.sameGesture.deck} · tab ${c.sameGesture.tab} · landing ${c.sameGesture.landing}`,
      ok(c.sameGesture.total));
    if (c.postClose.total && !c.sameGesture.total) {
      L("%c  ⭐ POST-CLOSE > 0 while SAME-GESTURE = 0 — this is EXACTLY defect B: momentum minted a " +
        "fresh gesture with a fresh budget. The historical counter cannot see it.", "color:#c00;font-weight:bold");
    }
    if (c.postClose.rows.length) console.table(c.postClose.rows);

    // ---- how many gestures were minted by momentum? ----
    const mints = wheels.filter((r) => r.minted);
    const momentumMints = mints.filter((r) => r.mom === true || (typeof r.mPhase === "string" && r.mPhase !== "none"));
    L("%cQ8 GESTURES MINTED", "font-weight:bold");
    L(`%c  total ${mints.length}   minted BY A MOMENTUM EVENT: ${momentumMints.length}`, ok(momentumMints.length));
    L("%c  ⭐ after B lands this must be 0 on any engine exposing the flag.", "color:#666");
    if (momentumMints.length) console.table(momentumMints);

    // ---- Q5 calibration ----
    const dts = wheels.map((r) => r.dt).filter(Number.isFinite);
    const mags = wheels.map((r) => Math.abs(r.dy)).filter((n) => n > 0);
    const ints = mags.filter((m) => Number.isInteger(m)).length;
    L("%cQ5 CALIBRATION (measured, not assumed)", "font-weight:bold");
    console.table([{
      "dt p50": fmt(pct(dts, 0.5)), "dt p90": fmt(pct(dts, 0.9)), "dt p99": fmt(pct(dts, 0.99)),
      "dt max": fmt(Math.max(...dts)),
      "|dy| p50": fmt(pct(mags, 0.5)), "|dy| p90": fmt(pct(mags, 0.9)), "|dy| max": fmt(Math.max(...mags)),
      "integer |dy| %": mags.length ? Math.round((ints / mags.length) * 100) : 0,
      "gaps > 100ms": dts.filter((d) => d > 100).length,
    }]);
    L("%c  ⚠︎ 'gaps > 100ms' is --gesture-gap. Every one of those mints a gesture on the legacy path.", "color:#666");

    L("%cFULL BUFFER", "font-weight:bold");
    console.table(rows);
    return {
      samples: rows.length,
      supports,
      postClose: c.postClose.total,
      sameGesture: c.sameGesture.total,
      momentumMints: momentumMints.length,
    };
  }

  const api = {
    on: true, push, wheel, report, clear, bind,
    /** raw buffer + both counters, no console. For headless probes and regression tests. */
    data: () => ({ supports, nonStandard, seen: Object.fromEntries(
      Object.entries(seen).map(([k, v]) => [k, [...v]])), counts: counts(), rows: [...rows] }),
    /**
     * ⭐ A CAPTURE FROM A FLAGGED ENGINE IS LABELLED TRAINING DATA.
     * Safari exposes no momentum signal, so it is stuck on heuristics — but Chrome now
     * reports ground truth for the very same physical gesture on the very same trackpad.
     * So: capture on Chrome, and every event arrives already labelled user-or-inertia. Any
     * candidate heuristic for the flagless path can then be SCORED against real labels
     * instead of argued about.
     *
     * This is strictly better than the plan the brief retired ("measure the Chrome stream,
     * then tune --claim-rise/--claim-floor"): same measurement, now with an answer key.
     *
     *   copy(window.__trace.export())      // in Chrome, after a capture
     */
    export: () => JSON.stringify({
      ua: navigator.userAgent,
      supports, nonStandard,
      // one compact row per wheel event: everything a discriminator could key on
      cols: ["t", "dt", "dx", "dy", "momentum", "gestureId", "minted"],
      rows: rows.filter((r) => r.k === "wheel")
        .map((r) => [r.t, r.dt, r.dx, r.dy, r.mom ?? null, r.g, r.minted ? 1 : 0]),
    }),
  };
  return api;
}
