/**
 * gesture-arbiter.mjs — the wheel-gesture arbiter, extracted verbatim from
 * prototype-v6.html (2026-08-13) with NO behavioural change.
 *
 * Why this file exists: hooks.md § "Codebase health check (2026-08-09)" names the
 * absence of a regression test as the top risk in the project, and any refactor
 * before one exists as "uninsured". The Astro port IS that refactor. This module
 * is ~120 lines of pure logic with no DOM dependency, so it can be pinned by the
 * scenarios eight rounds of work already produced.
 *
 * READ hooks.md § "✅ SETTLED (2026-08-09) — the gesture arbiter, final shape"
 * before changing anything here. The comments below are the failure record and are
 * load-bearing; they are the only thing stopping the next reader re-walking the
 * seven documented dead ends.
 *
 * THE MODEL, in one place — two questions, never conflated:
 *
 *   DECK        (ownsCarousel) did this gesture BEGIN in the deck?   -> gRegion
 *               wrong answer costs: a few px of drift
 *   TRANSITIONS (gestureLive)  has this gesture spent its one lerp?  -> spentOn
 *               wrong answer costs: the view changes
 *
 * Four boundary signals live in segment(): silence · decisive reversal · re-push
 * (transitions only) · deck re-claim (deck only). The last two are CAPABILITY
 * GRANTS, not boundaries — they must never mint a gesture. See rule 1 below.
 *
 * The three rules, in order of what they cost to learn:
 *   1. Scope the grant, not just the threshold. A mechanism that can MINT a gesture
 *      must never be cheaper than the most expensive thing a gesture may do.
 *   2. Gate each consumer by the question IT needs answered.
 *   3. Every heuristic must state which PHASE of a gesture it assumes.
 *
 * NEVER RETRY (7 dead ends, all pinned as tests in gesture-arbiter.test.mjs):
 *   fixed post-commit window · --freeze-after-lerp · decay floor (--momentum-floor)
 *   · unguarded rise test · bare sign test · peak-relative coast floor · region
 *   ownership replacing the transition counter outright.
 */

/** Defaults mirror prototype-v6.html's `:root` [TUNE] tokens as ACTUALLY DECLARED. */
export const ARBITER_DEFAULTS = Object.freeze({
  gestureGap:     100,   // --gesture-gap      silence that ends a gesture (ms)
  reverseFrac:    0.25,  // --gesture-reverse  decisive reversal, vs the gesture's own peak
  repushRun:      3,     // --repush-run       consecutive rises that count as a human (0 = off)
  repushFloor:    0.2,   // --repush-floor     each rise must also clear this fraction of peak
  repushArm:      0.25,  // --repush-arm       coast must first decay below this fraction of peak
  claimRise:      1.5,   // --claim-rise       deck re-claim, vs the coast trough
  claimFloor:     0.2,   // --claim-floor      ...and at least this fraction of the peak
  commitDist:     120,   // --commit-dist      forward: px of accumulated intent
  commitVel:      1.2,   // --commit-vel       forward: px/ms flick
  commitDistBack: 200,   // --commit-dist-back back/up: px of accumulated intent
  commitVelBack:  1.8,   // --commit-vel-back  back/up: px/ms flick
  idleReset:      200,   // (not a token in v6 — a hardcoded literal; see NOTES)
  debug:          false, // --gesture-debug

  // ---- B (2026-08-17): TELLING THE USER FROM THE PLATFORM ------------------------------
  // Two ways, chosen per event by what the engine offers.
  //
  //   FLAGGED   WheelEvent.momentum (Chrome 151+, boolean). Exact, no thresholds.
  //   FLAGLESS  "the hole" — a coast is clock-driven and metronomic (~8.3ms on BOTH
  //             engines, rock steady). When a finger lands again the OS stops synthesising
  //             for a beat, leaving a 25-55ms gap before the first real event.
  //
  // ⚠︎ Safari exposes NOTHING — not momentum, not momentumPhase, not phase (measured
  // 2026-08-17, Version/26.2). motion-fork-brief.md assumed WebKit had the long-standing
  // non-standard pair; it does not. So the flagless path IS Safari and Firefox, not a
  // courtesy fallback for engines nobody uses.
  //
  // ⭐ Why the hole should transfer across engines where a delta-shape rule cannot: it is
  // the OS pausing its own synthesis when real input arrives, upstream of both engines.
  // The measured hole durations match (Chrome 25-50ms, Safari 30-54ms) despite completely
  // different momentum implementations.
  //
  // Scored by gesture/score-heuristic.mjs against Chrome's own momentum labels:
  //   6 of 6 resumes detected, 0 false positives; 0 false positives across 496 events of
  //   pure coast; fires 7/7 at real push points on an unlabelled Safari capture.
  //
  // ⚠︎ RETUNE WITH THE SCORER, NEVER BY ARGUMENT. Two earlier candidates were convincing in
  // prose and died on exactly this test: "amplitude rose" is DEAD END #4 (|dy| rises up to
  // 2.0x inside a pure coast), and "dx !== 0" was perfect on Chrome and inverted on WebKit
  // (0/461 vs 140/144) because Chrome axis-locks its fling while Safari decays the whole
  // velocity vector.
  holeRatio:      2.5,   // dt must exceed this multiple of the recent median dt
  holeMinMs:      18,    // ...and this absolute floor, so a 4ms->10ms wobble never counts
  holeLive:       8,     // ...and the COAST BEFORE THE HOLE must still be this big.
                         //    ⚠︎ Tested against the coast, NOT this event: a real resume's
                         //    first event is tiny (measured: 1,3,5,2,3,7) because the finger
                         //    has only just landed, so gating on it throws away every true
                         //    positive. What separates them is what came BEFORE the hole —
                         //    median |v| of 15/26/19/28/38/30 before a real resume, vs 2
                         //    before the dying tail hands off from 120Hz to 60Hz.
  holeWindow:     5,     // events the medians are taken over
  gateHoleMs:     28,    // ⚠︎ SEPARATE, LARGER floor for releasing site.js's native-scroll
                         //   gate — see coasting(). Measured on Safari, 2026-08-17:
                         //     frame-rate handoff holes (120Hz -> 60Hz -> 30Hz)  max 24ms
                         //     real second pushes                                min 30ms
                         //   28 sits between. ⚠︎ THAT IS A 4ms AND 2ms MARGIN, fitted to
                         //   nine samples on one trackpad. It is the least-evidenced number
                         //   in this file. If a handoff ever reads as a push, the leak is a
                         //   few px of dead coast; if a push reads as a handoff, the user is
                         //   briefly locked out. Re-measure with gesture/score-heuristic.mjs
                         //   before trusting it on other hardware.
                         //   A sturdier discriminator exists if this proves flaky: a handoff
                         //   is followed by MORE clock-regular events, a finger by sub-6ms
                         //   irregular ones. That costs a 2-3 event delay to decide.
  /**
   * ⭐ HOW MANY CONSECUTIVE CLOCK-REGULAR EVENTS BEFORE WE CALL IT A COAST — see coastLikely().
   *
   * ⚠︎ DELIBERATELY LATE, AND THAT IS THE WHOLE DESIGN. score-heuristic.mjs killed the last
   * flagless coast classifier because it had to answer AT THE START of a coast, at speed, and
   * scored 70 false "finger" calls in 461 events — all clustered at the start, exactly where a
   * wrong answer commits a transition. coastLikely() has the opposite requirement: it releases
   * a GIVE, where a give that resolves 80ms late is invisible and one that resolves 800ms late
   * is the bug being fixed. So it demands a long run and is strong precisely where that
   * classifier was weak.
   *
   * ⚠︎ Cost of being wrong is bounded in both directions: a false coast springs a give back
   * early (mild, visible); a false finger is today's behaviour (the give hangs). It cannot
   * commit anything — no caller uses it to gate a transition, and none should.
   *
   * ⛔ UNSCORED. 10 events is ~83ms at both engines' ~8.3ms coast cadence. That is reasoning,
   * not measurement, and this project has twice been wrong about exactly this kind of
   * reasoning. Score it with gesture/score-heuristic.mjs on a real capture
   * (gesture/capture-wheel.html) before trusting the number.
   */
  coastRun:       10,
  coastSpread:    0.6,   // (max-min)/median of recent dt that still counts as CLOCK-DRIVEN.
                         //   ⚠︎ This is the flagless statement of "a coast was running", and
                         //   it is what the first cut was missing. Measured dt spread:
                         //     coast   chrome 0.24   safari 0.25
                         //     ramp    chrome 1.30   safari >>1 (duplicate timestamps, 0-3ms
                         //                                       between 30ms jumps)
                         //   Without it a finger RAMP can present as a hole.

  // ⛔ v6 EMULATION — A TEST HARNESS SETTING, NEVER SHIPPED.
  // Restores the amplitude heuristics this replaces (§3 re-push, §4 deck re-claim) exactly,
  // so differential.test.mjs can still prove the extraction was faithful to
  // prototype-v6.html. The differential is a FIDELITY test: any intentional behaviour change
  // makes it un-greenable by construction, so the choice is between freezing behaviour
  // forever and giving the test its own mode. This is that mode.
  compat:         false,
});

/**
 * @param {object} cfg  overrides for ARBITER_DEFAULTS
 * @param {object} env  the three facts the arbiter reads from the outside world:
 *   detailOpen()  -> boolean  is the detail card up?
 *   tabTopY()     -> number   y of the tab strip's top edge. ⚠︎ THIS MOVES as the
 *                             card closes — that motion is the parked-bug mechanism
 *                             the gRegion claim exists to defeat.
 *   deckBottomY() -> number   OPTIONAL. Lower edge of the deck region — the artwork band,
 *                             not the hero. Defaults to tabTopY (v6 geometry). See A.
 *   tweenActive() -> boolean  is a stage/world tween in flight? (stageTween||worldTween)
 */
export function createArbiter(cfg = {}, env = {}) {
  const C = { ...ARBITER_DEFAULTS, ...cfg };
  const detailOpen  = env.detailOpen  ?? (() => false);
  const tabTopY     = env.tabTopY     ?? (() => 0);
  /**
   * ⭐ A (2026-08-17): the deck region's LOWER EDGE, which is not the tab frame's top.
   * `.carousel` used to be `height: 100%` of `.hero`, so "over the carousel" meant "over
   * the whole hero" — and the empty band below the artwork browsed the deck when the design
   * says it should leave the landing (~170px at a 900px viewport, ~320px at 1200px).
   * ⚠︎ Defaults to tabTopY so every existing test and caller keeps v6's geometry, and
   * compat forces it, so differential.test.mjs stays exact.
   */
  const deckBottom  = () => (C.compat ? tabTopY() : (env.deckBottomY ?? tabTopY)());
  const tweenActive = env.tweenActive ?? (() => false);
  const log = C.debug ? (m) => console.log(m) : () => {};

  // ---- intent accumulator ----
  let acc = 0;

  // ---- per-gesture accounting: a BUDGET and a CLAIM ----
  let gestureId = 0;      // ordinal of the gesture currently in progress
  let spentOn   = -1;     // gesture that already produced a transition
  let gRegion   = null;   // "detail" | "carousel" | "frame" — where THIS gesture began

  let prevDir = 0;        // direction of the last DECISIVE event (noise never sets it)
  let peak    = 0;        // largest |deltaY| this gesture reached — the yardstick
  let cTrough = Infinity; // coast low-water mark, for the deck's own re-claim

  // RE-PUSH detector state (transitions only). Measured since the last COMMIT.
  let rPeak = 0, rTail = false, rArmed = false, rRun = 0, rPrev = Infinity;

  // ---- B: the flagless resume detector ("the hole"). Rolling medians only. ----
  const dtHist = [], vHist = [];
  // ⭐ has the PLATFORM been coasting? A finger event is only a resume if it interrupts one.
  let sawCoast = false;
  /**
   * ⭐ HAS THIS PHYSICAL STREAM ALREADY BEEN USED BY A NATIVE SCROLLER?
   *
   * Separate from `spentOn` because a MINT RESETS THE BUDGET AND A REVERSAL CAN MINT.
   * Measured on JJ's Safari stream, 2026-08-17: scrolling down inside a card and then
   * flicking up trips the decisive-reversal boundary, so `newGesture()` runs mid-flick and
   * hands the rest of that same physical swipe a fresh, LIVE budget:
   *
   *     t=17389  dy=-12  g=10   the up-flick starts
   *     ...                     ~102px of card scrolled, all of it spending gesture 10
   *     t=17414  dy=-71  g=11   MINTED — reversal needed mag >= peak*0.25 (282*0.25 = 70.5)
   *
   * By then the card is at its top, gesture 11 is live, and -71px at 6ms is 11.8px/ms
   * against a 1.8px/ms threshold. The close fires on a swipe that was spent scrolling.
   *
   * ⚠︎ So `spendOnNativeScroll()` alone could never have worked, and the reversal boundary
   * is not the thing to weaken — it is what makes a lerp catchable, which is load-bearing.
   * This flag rides ACROSS a reversal-mint and is cleared only by a real end of stream:
   * silence, a resume, or a transition actually firing.
   */
  let scrollSpent = false;
  // consecutive events sitting inside a clock-regular window — the flagless half of
  // coastLikely(). Never feeds a commit; see coastRun.
  let regRun = 0;
  // the last event's momentum flag, or undefined on an engine that has none. PATH SELECTION,
  // the same rule the rest of this file uses: an exact answer beats a measured one.
  let lastMomentum;
  // has anything interrupted this gesture's coast? Drives coasting(); see below.
  let holeSeen = false;
  /**
   * ⭐ IS THE CURRENT DEVICE DISCRETE? (the deltaMode guard, 2026-08-18)
   *
   * `WheelEvent.deltaMode !== 0` means the engine handed us LINES or PAGES, which it only
   * does for a click-detented mouse wheel. Such a device does not coast — there is no
   * inertia to interrupt — so every piece of coast machinery below is not merely useless
   * on it, it is actively wrong. See the guard in segment() for the measured failure.
   *
   * ⚠︎ SCOPE, AND IT IS ONE ENGINE. Measured browser behaviour, 2026-08-18:
   *     Firefox   mouse -> DOM_DELTA_LINE   trackpad -> DOM_DELTA_PIXEL   ✅ exact
   *     Chrome    both  -> DOM_DELTA_PIXEL  (premultiplied)               — has the flag
   *     Safari    both  -> DOM_DELTA_PIXEL                                ⛔ BLIND
   * So this closes Firefox completely, Chrome does not need it (`momentum` is exact), and
   * ⛔ **Safari + a real mouse is still an OPEN DEFECT.** Safari's only tell is that mouse
   * deltas are much larger than trackpad ones — an AMPLITUDE rule, which is dead end #4's
   * exact shape. It does not ship until gesture/score-heuristic.mjs scores it on a real
   * capture. Use gesture/capture-wheel.html to make one.
   */
  let lastDiscrete = false;
  const median = (a) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[s.length >> 1];
  };
  /**
   * Did the USER just take over from a coast?
   * @param {boolean|undefined} momentum  e.momentum, where the engine provides it
   * @param {number} dt
   * @param {number} vmag  ⚠︎ the VECTOR magnitude, hypot(dx,dy) — not `mag`.
   *   This is what makes defect C fall out of B rather than needing its own fix. v6's deck
   *   re-claim tested `mag = |deltaY|`, so a pure horizontal gesture had mag 0 and the
   *   re-claim was STRUCTURALLY UNREACHABLE by horizontal input: after a card closed with
   *   the claim on "detail", a sideways swipe — the most natural way to browse a horizontal
   *   carousel — could never win the deck back. Feeding the resume detector the vector
   *   magnitude fixes that, and deliberately does NOT touch `peak`, which is the reversal
   *   yardstick and would change segmentation globally.
   */
  function resumed(momentum, dt, vmag) {
    // ⭐⭐ A RESUME IS A TRANSITION, NOT A PROPERTY OF ONE EVENT.
    // The 2026-08-17 first cut asked only "is this event a finger", and traded the jam for
    // a leak on the engine that has the flag. The reason is the close flick's own TAIL:
    // closeDetail() flips detailOpen false MID-FLICK, and the six-or-so finger events still
    // arriving from that same physical swipe are all `momentum === false`. They re-claimed
    // the deck and re-armed the transition, so the coast behind them drove the carousel
    // (Chrome) and one flick spent two lerps (card -> landing at tab-top).
    //
    // ⚠︎ The correct definition was already written down, in gesture/score-heuristic.mjs,
    // as the GROUND TRUTH the detector was scored against: "the first `momentum === false`
    // event that FOLLOWS at least one `momentum === true` event." The scorer was right and
    // the implementation did not match it. A coast must have happened first.
    //
    // Engine asymmetry confirms the diagnosis: Safari showed no carousel leak, because the
    // flagless path needs a HOLE and a continuous flick tail has none.
    if (momentum === true) { sawCoast = true; return false; }
    if (momentum === false) {
      if (!sawCoast) return false;            // the flick's own tail is a finger, not a resume
      sawCoast = false;                       // one grant per coast
      return true;
    }
    // ---- flagless: the hole, plus the same precondition expressed as a MEASUREMENT.
    // ⚠︎ `holeLive` alone does not say "a coast was running" — a finger ramp is large too.
    // What separates them is regularity: a coast is clock-driven (dt spread ~0.25 of the
    // median) and a finger is not (Chrome ramp ~1.3, Safari ramp far worse — its ramps carry
    // duplicate timestamps and dt of 0-3ms between 30ms jumps). Without this gate a Safari
    // ramp can itself look like a hole, which is the other half of what JJ saw.
    if (dtHist.length < C.holeWindow) return false;
    const med = median(dtHist);
    const spread = med ? (Math.max(...dtHist) - Math.min(...dtHist)) / med : Infinity;
    return spread <= C.coastSpread
        && dt >= C.holeMinMs
        && dt >= med * C.holeRatio
        && median(vHist) >= C.holeLive;
  }

  /** one test for "did the user mean it", per direction */
  const meant = (accum, delta, dt, back) =>
    accum > (back ? C.commitDistBack : C.commitDist) ||
    (delta / Math.max(1, dt)) > (back ? C.commitVelBack : C.commitVel);

  /**
   * Which consumer owns a gesture starting here, right now. Evaluated ONCE per gesture.
   * detailOpen wins outright: while the card is up the deck is not reachable at all, so a
   * gesture born there can never be a deck gesture no matter what the geometry does later.
   */
  const regionAt = (clientY) =>
    detailOpen() ? "detail" : (clientY < deckBottom() ? "carousel" : "frame");

  /**
   * Called AS a commit fires. `peak` is NOT reset — the gesture is still running and its
   * amplitude is what the reversal test scales against. `gRegion` is NOT reset either:
   * spending a gesture doesn't change where it began.
   */
  function consume() {
    spentOn = gestureId; acc = 0; scrollSpent = false;
    regRun = 0;         // a transition just fired; whatever the stream was doing, restart
    sawCoast = false;   // ⚠︎ closeDetail() spends HERE, mid-flick. The finger events still
                        // arriving from this same swipe must not read as a resume.
    holeSeen = false;
    rPeak = 0; rTail = false; rArmed = false; rRun = 0; rPrev = Infinity;  // watch the coast
  }

  function newGesture(dir, mag, why, clientY) {
    gestureId++;
    gRegion = regionAt(clientY);
    log(`[gesture #${gestureId}] ${why}  mag ${mag.toFixed(1)}  claims ${gRegion}`);
    prevDir = dir; peak = mag; acc = 0; cTrough = Infinity; sawCoast = false; holeSeen = false;
    regRun = 0;
    rPeak = 0; rTail = false; rArmed = false; rRun = 0; rPrev = Infinity;
  }

  function segment(deltaY, dt, clientY, deltaX = 0, momentum, deltaMode = 0) {
    const mag = Math.abs(deltaY), dir = deltaY < 0 ? -1 : 1;
    const vmag = Math.hypot(deltaX || 0, deltaY);
    /**
     * ⭐ THE deltaMode GUARD. A discrete device bypasses ALL coast machinery.
     *
     * THE DEFECT IT FIXES, measured off this file 2026-08-18. The flagless detector asks
     * "regular cadence, then a hole, with size behind it" — and a hand spinning a wheel at
     * a steady rate IS regular, and every click IS large. So a mouse manufactures a resume
     * out of nothing more than an ordinary hesitation:
     *
     *     cadence   hesitation that spuriously resumes
     *     16ms      45, 60, 75, 90, 99ms   (any)
     *     25-30ms   75, 90, 99ms
     *     >=40ms    none — 2.5x median lands past --gesture-gap, so silence mints instead
     *
     * A spurious resume clears `spentOn`, so ONE continuous wheel-spin re-arms the
     * transition over and over: "one gesture = one lerp" is gone for every mouse user on
     * the flagless path, and it degrades with hardware — the faster the wheel reports, the
     * wider the window.
     *
     * ⚠︎ Note the flagged path was NEVER exposed to this: `resumed()` requires a prior
     * `momentum === true`, and a mouse never produces one. Chrome was fine. This is
     * Firefox and Safari only, which is exactly the half with no flag to fall back on.
     *
     * ⭐ Deliberately NOT a threshold. Three things die together, and each is a real bug:
     *   1. resume        — the measured defect above
     *   2. the histories — so a device switch cannot leave a stale coast model behind
     *   3. coasting()    — a mouse never sets `holeSeen` at >=40ms cadence, so the
     *                      native-scroll gate would latch ON and never release: a LOCKOUT,
     *                      the same failure `gateHoleMs` exists to prevent.
     * ⛔ compat is untouched — v6 had none of this machinery, so the differential stays
     * exact by construction, not by a flag.
     */
    const discrete = !C.compat && deltaMode !== 0;
    if (discrete !== lastDiscrete) { dtHist.length = 0; vHist.length = 0; }
    lastDiscrete = discrete;
    // evaluated BEFORE the histories absorb this event
    const isResume = (C.compat || discrete) ? false : resumed(momentum, dt, vmag);
    // ⭐ THE GATE'S OWN, CHEAPER QUESTION — rule 2, applied properly.
    // A full resume re-arms a TRANSITION, where a wrong answer changes the view, so it
    // demands hole + regularity + a live coast. Releasing site.js's native-scroll gate only
    // costs a few px of scroll, so it must NOT demand liveness — the lockout it would
    // otherwise cause is real (JJ, Safari: a push 62ms after the coast had decayed to 1px).
    // Instead it pays a larger absolute floor, which is what separates a real push from the
    // frame-rate handoff a dying coast performs.
    /**
     * ⭐ regRun — the flagless evidence for coastLikely(). A coast is clock-driven and
     * metronomic; a finger is not (measured dt spread: coast 0.24/0.25, ramp 1.30/≫1). This
     * asks BOTH that the recent window is regular AND that this event matches its cadence, so
     * a single well-timed event inside a ragged stream cannot advance the run.
     * ⚠︎ A TIMING property, not an amplitude one — dead end #4 was "amplitude rose", and this
     * is deliberately not that.
     */
    if (C.compat || discrete) regRun = 0;
    else if (dtHist.length >= C.holeWindow) {
      const m = median(dtHist);
      const sp = m ? (Math.max(...dtHist) - Math.min(...dtHist)) / m : Infinity;
      const near = m ? Math.abs(dt - m) <= m * C.coastSpread : false;
      regRun = (sp <= C.coastSpread && near) ? regRun + 1 : 0;
    } else regRun = 0;
    lastMomentum = momentum;

    if (!C.compat && !discrete && !holeSeen && dtHist.length >= C.holeWindow) {
      const m = median(dtHist);
      const sp = m ? (Math.max(...dtHist) - Math.min(...dtHist)) / m : Infinity;
      if (sp <= C.coastSpread && dt >= C.gateHoleMs && dt >= m * C.holeRatio) holeSeen = true;
    }
    const push = () => {
      if (C.compat || discrete) return;
      dtHist.push(dt); vHist.push(vmag);
      if (dtHist.length > C.holeWindow) { dtHist.shift(); vHist.shift(); }
    };

    // 1. SILENCE — the only amplitude-independent signal in v6's model.
    //    ⚠︎ THE LOCKED ASSUMPTION BEHIND IT IS FALSE. "The one property a coast cannot
    //    violate is that it ENDS" — measured, a coast's longest internal gap is 67ms on
    //    Chrome and 54ms on Safari, both UNDER --gesture-gap, so a coast never mints. Good.
    //    But the converse is what bites: a finger landing mid-coast leaves only a 25-55ms
    //    hole, also under the gap, so a REAL second push never mints either. That is the
    //    jam. Silence is not wrong here, it is just blind in both directions.
    if (dt > C.gestureGap) {
      // A flagged momentum event may never mint. On the flagless path this cannot trigger
      // anyway (no coast gap ever reached 100ms in any capture), so there is nothing to
      // guard and nothing to guess at.
      if (momentum === true) { push(); return; }
      // ⭐ SILENCE IS A REAL END OF STREAM — the finger is off and the coast has died. This
      // is the ONLY mint that clears scrollSpent; a reversal-mint deliberately does not.
      scrollSpent = false;
      newGesture(dir, mag, `gap ${Math.round(dt)}ms`, clientY);
      push();
      return;
    }

    if (mag > peak) peak = mag;

    // 2. DECISIVE REVERSAL. `peak > 0` guards the deltaX-only case (mag 0 must never
    //    qualify). This is what keeps a lerp catchable.
    const decisive = peak > 0 && mag >= peak * C.reverseFrac;
    if (decisive) {
      if (prevDir !== 0 && dir !== prevDir) {
        newGesture(dir, mag, `reversal ${mag.toFixed(1)} vs peak ${peak.toFixed(1)}`, clientY);
        push();
        return;
      }
      prevDir = dir;        // only decisive events define direction; jitter cannot flip it
    }

    // 3. RE-PUSH — a THIRD boundary signal for transitions only, and A SCOPED GRANT.
    //    ⚠︎ The literal ">= previous delta" heuristic false-fires 100% of the time on a
    //    modern Chrome stream, because deltas are QUANTIZED TO INTEGERS and a decaying
    //    tail plateaus (1,1,1,1…). Measured false-fire rates, pure coast at ±10%/±25%:
    //      >= literal 100%/100% · strict > 72%/100% · +floor 62%/99.9% · +run-of-N 0%/0.1%
    //    ⭐ THE GRANT IS SCOPED: it clears `spentOn` and NOTHING else. `gRegion` is
    //    deliberately untouched, so a false positive costs at most one transition and can
    //    never reach the deck. The identical detector wrapped in newGesture() was rolled
    //    back the same day it was tried.
    // ⭐ B — THE REPLACEMENT FOR §3 AND §4, on both live paths.
    // One signal, two scoped grants, in the same order and with the same scopes v6 used.
    // Neither can mint a gesture: the whole safety argument of rule 1 is preserved.
    if (!C.compat) {
      if (isResume) {
        // (a) TRANSITIONS — v6's §3 re-push, without the amplitude machinery.
        //     ⚠︎ NO tweenActive() GUARD, deliberately. v6 froze this while a lerp ran, for
        //     two reasons that no longer hold: "the stream is at its least trustworthy"
        //     dies with a definite resume signal, and "a SECOND transition before the first
        //     has landed is premature" contradicts site.js's own top note — "a commit in
        //     the opposite direction catches the lerp and re-aims it." Catching a lerp
        //     mid-flight is a feature, and DEAD 1/2 already rejected post-commit windows.
        if (spentOn === gestureId) {
          spentOn = -1; acc = 0; rRun = 0;
          log(`[gesture #${gestureId}] RESUME — transition re-armed (hole/flag)`);
        }
        scrollSpent = false;   // a deliberate new push earns the card boundary back too
        regRun = 0;            // ...and the finger is demonstrably back, so the coast is over
        // (b) THE CLAIM — v6's §4, same scope: hands back a region, never a transition.
        // ⚠︎ Re-claims WHEREVER THE CURSOR IS, not only over the carousel. v6 could only
        // ever grant "carousel", which left a stale "detail" claim sitting on a gesture in
        // tab view long after the card was gone — and `region() !== "detail"` is what
        // site.js uses to decide whether a gesture may reach native scroll at all. So the
        // stale claim was load-bearing in a place nobody had looked.
        // This is still a claim, never a budget: it cannot mint and cannot spend.
        if (!detailOpen() && gRegion !== regionAt(clientY)) {
          gRegion = regionAt(clientY);
          log(`[gesture #${gestureId}] RESUME — re-claimed, now ${gRegion}`);
        }
      }
      if (spentOn === gestureId) acc = 0;
      push();
      return;
    }

    if (C.repushRun && spentOn === gestureId) {
      if (tweenActive()) {
        // While the transition is still animating the stream is at its least trustworthy,
        // and authorising a SECOND transition before the first has landed is premature.
        // Hold, and keep the baseline fresh so the first post-tween event can't read as a rise.
        rRun = 0; rPrev = mag;
      } else if (!rTail) {
        // Absorb the RAMP first. A commit can fire on event 1 (closing a card from 0%), so
        // without this the gesture's own acceleration is a run of increases by definition —
        // precisely how the round-4 rise test died.
        if (mag > rPeak) rPeak = mag; else { rTail = true; rPrev = mag; }
      } else {
        // ARM GATE: the coast must first fall BELOW repushArm x this gesture's own peak.
        // Momentum always decays that far; a gesture the user is still actively driving does
        // not. Scale-relative. With it: drawn-out 95% -> 0%, genuine second flick still 100%.
        if (!rArmed && mag < peak * C.repushArm) rArmed = true;
        if (rArmed) {
          if (mag > rPrev && mag > peak * C.repushFloor) rRun++; else rRun = 0;
          if (rRun >= C.repushRun) {
            spentOn = -1; acc = 0; rRun = 0;   // scoped grant: one transition, earned afresh
            log(`[gesture #${gestureId}] RE-PUSH granted (run of ${C.repushRun}, mag ` +
                `${mag.toFixed(1)}) — transition only, deck stays ${gRegion}`);
          }
        }
        rPrev = mag;
      }
    }

    // 4. DECK RE-CLAIM — the deck's OWN boundary rule, and NEVER a transition's.
    //    ⚠︎ THE SCOPE OF THIS TEST IS THE WHOLE SAFETY ARGUMENT. It may hand back the DECK,
    //    where a wrong answer costs a few px of drift. It must never hand back a TRANSITION,
    //    where a wrong answer changes the view.
    //    The "no tween in flight" guard is load-bearing: a commit can fire during the
    //    gesture's own RAMP, and that ramp is always inside the tween the commit started, so
    //    the acceleration would read as a fresh push.
    const overCarousel = !detailOpen() && clientY < deckBottom();
    if (gRegion !== "carousel" && overCarousel && !tweenActive()) {
      if (cTrough === Infinity) cTrough = mag;                  // seed once the tween is done
      else if (mag > cTrough * C.claimRise && mag > peak * C.claimFloor) {
        gRegion = "carousel";                                   // the user is driving again
        log(`[gesture #${gestureId}] carousel RE-CLAIMED, mag ${mag.toFixed(1)} ` +
            `over trough ${cTrough.toFixed(1)}`);
      } else cTrough = Math.min(cTrough, mag);
    } else if (tweenActive()) cTrough = Infinity;               // re-seed after the transition

    if (spentOn === gestureId) acc = 0;   // don't bank intent behind a spent gesture
  }

  // ---- what may act, and on whose authority ----
  // TRANSITIONS keep the strict counter: one gesture = one lerp. The conservative half, and
  // it stays that way — 2026-08-09 tried replacing it with region ownership plus a re-push
  // test and it put BOTH momentum failures straight back.
  const gestureLive  = () => spentOn !== gestureId;
  // ...ownership guards every JS-DRIVEN SCROLL REMAP. A different question: the deck commits
  // nothing, so it is never "spent", so it is never gated by the counter.
  const ownsCarousel = () => gRegion === "carousel";

  return {
    /**
     * ── THE THREE EXTERNAL CONTROL POINTS ────────────────────────────────────────
     * v6 wrote these closure variables directly from outside the wheel path. Surfaced
     * here as named operations so they are visible, testable, and cannot be done by
     * accident. FOUND 2026-08-13 when the ported shell threw `gRegion is not defined`:
     * the original extraction covered only the wheel path, and the differential test
     * passed because it only exercised the wheel path too.
     */

    /**
     * Claim a region outright, outside any gesture boundary. Used by `openDetail()`:
     * opening is CLICK-driven so there is no gesture to consume, but a gesture may still
     * be in flight (a tap can land mid-coast) holding a "carousel" claim. The card is now
     * up, so nothing in flight can be a carousel gesture any more.
     * ⚠︎ Does NOT mint a gesture — it must not hand out a transition. Rule 1: scope the grant.
     */
    claimRegion(region) { gRegion = region; },

    /** Read the current claim. The wheel handler's horizontal branch asks this directly. */
    region: () => gRegion,

    /**
     * Mint a gesture at a boundary the CALLER knows about. `touchstart` is a real gesture
     * boundary — better signal than anything recoverable from a wheel stream — and it is
     * where a touch gesture stakes its claim, from the finger's own landing point.
     * ⚠︎ Mirrors v6 EXACTLY: it advances the id, clears the budget and re-claims, and
     * deliberately does NOT reset peak/prevDir/the re-push state the way newGesture() does.
     * Do not "tidy" this into a newGesture() call — that changes touch behaviour.
     */
    beginGesture(clientY) { gestureId++; spentOn = -1; gRegion = regionAt(clientY); },

    /** Feed one wheel event. Mirrors v6's handler order: idle-reset, then segment. */
    feed({ deltaY, dt, clientY, deltaX, momentum, deltaMode }) {
      if (dt > C.idleReset) acc = 0;
      segment(deltaY, dt, clientY, deltaX, momentum, deltaMode);
    },
    segment, consume, meant, gestureLive, ownsCarousel,
    /**
     * ⭐ THIS GESTURE IS BEING USED BY A NATIVE SCROLLER — spend it, same as a transition.
     *
     * The defect (JJ, Safari, 2026-08-17): "a hard flick from card to tab closes the card
     * with no momentum spill ONLY IF closed from the TOP. From anywhere below, an
     * overshoot." Flick up inside a scrolled card and the card scrolls natively to the top,
     * momentum still running hard — and the instant `scrollTop` hits 0 the boundary sees a
     * coast event of ~155px at ~8ms. `meant()`'s velocity term is 1.8px/ms. That is 19px/ms:
     * satisfied TEN TIMES OVER by a single event nobody pushed.
     *
     * ⚠︎ `meant()` never asks WHOSE event it is, and that is the whole bug. But the fix is
     * NOT a fourth momentum heuristic: scored against Chrome's labels, the best flagless
     * "is this a coast" classifier still called 70 of 461 coast events a finger, and those
     * 70 cluster at the START of a coast — exactly where a boundary gets reached at speed.
     * It would have put the overshoot straight back.
     *
     * So this uses the invariant the project already has instead of a new threshold: ONE
     * GESTURE, ONE ACTION. The flick was spent scrolling the card. Closing is a second
     * action and needs a second push — which B already detects at 100% on labelled data,
     * on both engines. `motion-fork-brief.md § J` specifies exactly this: "you released
     * before reaching the edge -> you stop at the top."
     *
     * ⚠︎ NOT `consume()`. That also clears `sawCoast` and `holeSeen`, and this fires on
     * every native-scroll event — so it would erase the coast-tracking the resume detector
     * needs, and the card could then never be closed at all. Spend the budget, touch
     * nothing else.
     */
    spendOnNativeScroll() { spentOn = gestureId; acc = 0; scrollSpent = true; },
    /** has this stream already been used by a native scroller? survives a reversal-mint. */
    scrollSpent: () => scrollSpent,
    /**
     * Is a LIVE coast still attached to this gesture?
     * ⚠︎ Exists so site.js can gate the one path it leaves to native scroll WITHOUT
     * creating a lockout. The gate must stop momentum from scrolling the panel a closing
     * card uncovers — but a coast that has decayed below `holeLive` can no longer be
     * detected as interrupted (a resume needs a live coast to interrupt), so holding the
     * gate past that point would trap the user until 100ms of silence minted a new gesture.
     * A dead coast is 1-3px an event and harmless. So: block while it can still do damage,
     * release when it cannot. Measured on both engines, that boundary is the same number
     * the resume detector already uses, which is why it is not a second threshold.
     * ⛔ Always false in compat — v6 had no such gate.
     */
    coasting: () => !C.compat && !lastDiscrete && !holeSeen,
    /**
     * ⭐ IS THE PLATFORM DRIVING THIS STREAM RIGHT NOW? The LATE, CONFIDENT answer.
     *
     * Exists so a GIVE can resolve when the finger leaves rather than when the stream goes
     * silent — `motion-fork-brief.md § J`'s exact prediction: "without a momentum signal
     * 'release' means silence past --gesture-gap, i.e. ~100ms AFTER momentum fully decays.
     * Give would stretch and hang."
     *
     *   FLAGGED    e.momentum === true. Exact, immediate, no thresholds.
     *   FLAGLESS   coastRun consecutive clock-regular events. ~83ms of evidence.
     *
     * ⛔ NEVER GATE A TRANSITION ON THIS. It is allowed to be wrong; see coastRun. The whole
     * reason it can ship unscored is that both of its failure modes are cosmetic.
     * ⛔ Always false in compat — v6 had no such notion.
     */
    coastLikely: () => !C.compat && (
      lastMomentum !== undefined ? lastMomentum === true : regRun >= C.coastRun),
    /** intent accumulator — the wheel handler banks px into this per branch */
    addIntent(delta) { acc += delta; return acc; },
    resetIntent() { acc = 0; },
    get intent() { return acc; },
    /** read-only introspection, for tests and the trace build */
    state() {
      return { gestureId, spentOn, gRegion, prevDir, peak, cTrough, acc,
               rPeak, rTail, rArmed, rRun, rPrev };
    },
    config: C,
  };
}
