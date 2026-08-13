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
});

/**
 * @param {object} cfg  overrides for ARBITER_DEFAULTS
 * @param {object} env  the three facts the arbiter reads from the outside world:
 *   detailOpen()  -> boolean  is the detail card up?
 *   tabTopY()     -> number   y of the tab strip's top edge. ⚠︎ THIS MOVES as the
 *                             card closes — that motion is the parked-bug mechanism
 *                             the gRegion claim exists to defeat.
 *   tweenActive() -> boolean  is a stage/world tween in flight? (stageTween||worldTween)
 */
export function createArbiter(cfg = {}, env = {}) {
  const C = { ...ARBITER_DEFAULTS, ...cfg };
  const detailOpen  = env.detailOpen  ?? (() => false);
  const tabTopY     = env.tabTopY     ?? (() => 0);
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
    detailOpen() ? "detail" : (clientY < tabTopY() ? "carousel" : "frame");

  /**
   * Called AS a commit fires. `peak` is NOT reset — the gesture is still running and its
   * amplitude is what the reversal test scales against. `gRegion` is NOT reset either:
   * spending a gesture doesn't change where it began.
   */
  function consume() {
    spentOn = gestureId; acc = 0;
    rPeak = 0; rTail = false; rArmed = false; rRun = 0; rPrev = Infinity;  // watch the coast
  }

  function newGesture(dir, mag, why, clientY) {
    gestureId++;
    gRegion = regionAt(clientY);
    log(`[gesture #${gestureId}] ${why}  mag ${mag.toFixed(1)}  claims ${gRegion}`);
    prevDir = dir; peak = mag; acc = 0; cTrough = Infinity;
    rPeak = 0; rTail = false; rArmed = false; rRun = 0; rPrev = Infinity;
  }

  function segment(deltaY, dt, clientY) {
    const mag = Math.abs(deltaY), dir = deltaY < 0 ? -1 : 1;

    // 1. SILENCE — the only amplitude-independent signal. A coast cannot violate the
    //    one property that it ENDS, so this is trustworthy at any scale.
    if (dt > C.gestureGap) {
      newGesture(dir, mag, `gap ${Math.round(dt)}ms`, clientY);
      return;
    }

    if (mag > peak) peak = mag;

    // 2. DECISIVE REVERSAL. `peak > 0` guards the deltaX-only case (mag 0 must never
    //    qualify). This is what keeps a lerp catchable.
    const decisive = peak > 0 && mag >= peak * C.reverseFrac;
    if (decisive) {
      if (prevDir !== 0 && dir !== prevDir) {
        newGesture(dir, mag, `reversal ${mag.toFixed(1)} vs peak ${peak.toFixed(1)}`, clientY);
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
    const overCarousel = !detailOpen() && clientY < tabTopY();
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
    feed({ deltaY, dt, clientY }) {
      if (dt > C.idleReset) acc = 0;
      segment(deltaY, dt, clientY);
    },
    segment, consume, meant, gestureLive, ownsCarousel,
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
