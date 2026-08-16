/**
 * site.js — the motion and interaction layer, ported from prototype-v6.html.
 *
 * WHAT CHANGED IN THE PORT, and nothing else did:
 *   · The panels (carousel, ART grid, news list, bio) are now PRE-RENDERED by Astro from
 *     real CMS content. The ~290 lines of v6 that built them in the browser are gone.
 *   · The gesture arbiter is imported from ./gesture-arbiter.mjs — ONE copy, pinned by
 *     61 tests including a differential check against v6 itself. It is not reimplemented
 *     here and must not be.
 *   · `--ease` IS NOW READ. In v6 the token was declared, documented [TUNE], and ignored:
 *     every tween hardcoded cubic-bezier(0.5,0,0,1). The 2026-08-09 health check called it
 *     "a lie" and the one cleanup worth doing unprompted. tween() parses it now.
 *   · Detail content is FETCHED from a `_content` partial, or ADOPTED from pre-rendered
 *     DOM on a cold /type/slug load. v6 built that markup in JS; that generator is gone,
 *     and so is the intermediate embedded-JSON payload P3 used. One renderer: <Work>.
 *
 * INVARIANTS CARRIED (each cost a round — see hooks.md):
 *   · one gesture = one lerp; the deck asks a different question from transitions
 *   · overscroll-behavior per axis, never the shorthand
 *   · a commit spends the gesture WHERE IT FIRES, not when the lerp lands
 */
import { createArbiter } from "../lib/gesture-arbiter.mjs";
import { titleCase, typeLabel, timeElapsed } from "../lib/format";
import { parseCssTime } from "../lib/css-time";
import { createTrace } from "../lib/trace.mjs";


{
  // ============================================================================
  // TRACE — inert unless ?trace=1. See src/lib/trace.mjs for what it measures, and
  // for why the harness lives in the BUILT app rather than in a standalone prototype.
  // ============================================================================
  const T = createTrace(new URLSearchParams(location.search).get("trace") === "1");

  // ============================================================================
  // MOTION PRIMITIVES — ported from prototype-tabsnap.html
  // ============================================================================
  const root = document.documentElement;

  // Newton-solved cubic-bezier(0.5, 0, 0, 1). Not a named easing preset, so it
  // needs a real solver; this is the curve every transition in the site rides.
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const fx = (t) => ((ax * t + bx) * t + cx) * t;
    const fy = (t) => ((ay * t + by) * t + cy) * t;
    return (x) => {
      let t = x;
      for (let i = 0; i < 6; i++) {
        const dx = fx(t) - x;
        if (Math.abs(dx) < 1e-4) break;
        const d = (3 * ax * t + 2 * bx) * t + cx || 1e-6;
        t -= dx / d;
      }
      return fy(t);
    };
  }
  /**
   * ⭐ FIXED IN THE PORT. v6 declared `--ease` as a [TUNE] token, documented it, and then
   * hardcoded this curve — so editing the token did nothing. The 2026-08-09 health check
   * named it "a lie" and the one cleanup worth doing unprompted. Now the token is the
   * source of truth and the literal is only the fallback.
   */
  function easeFromToken() {
    const raw = getComputedStyle(root).getPropertyValue("--ease").trim();
    const m = raw.match(/cubic-bezier\(([^)]+)\)/);
    if (m) {
      const n = m[1].split(",").map((x) => parseFloat(x));
      if (n.length === 4 && n.every(Number.isFinite)) return bezier(n[0], n[1], n[2], n[3]);
    }
    if (raw === "linear") return (t) => t;
    return bezier(0.5, 0, 0, 1);   // the curve v6 actually rode
  }
  const ease = easeFromToken();

  /**
   * ⚠︎ UNIT-AWARE, and it must stay that way. v6 used a bare parseFloat here, which is
   * correct only while nothing rewrites the CSS. Astro's production minifier rewrites
   * `500ms` to `.5s` — same duration, different string — and a bare parseFloat then
   * returns 0.5, turning every lerp into a cut and the gesture-gap into 0.1ms.
   * Full write-up in src/lib/css-time.ts.
   */
  const cssMs = (name, fallback) =>
    parseCssTime(getComputedStyle(root).getPropertyValue(name), fallback);
  const DUR = cssMs("--dur", 500);

  const cssNum = (name, fallback) => {
    const v = parseFloat(getComputedStyle(root).getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  // v3 reveal dynamics, read once from the tokens above
  const SITE_ZOOM  = cssNum("--site-zoom-max", 1.1);
  const SITE_BLUR  = cssNum("--site-blur-max", 50);
  const CARD_ZOOM  = cssNum("--card-zoom-min", 0.95);
  const FADE_FLOOR = cssNum("--fade-floor", 0.2);
  const BLUR_FLOOR = cssNum("--blur-floor", 0.4);

  // Generic value tween on the shared curve. Returns a CANCELLABLE handle: every
  // transition in the site can be caught mid-flight and re-aimed from wherever it
  // currently sits, rather than having to play out.
  function tween(from, to, dur, apply, done) {
    let cancelled = false;
    const t0 = performance.now();
    (function f(now) {
      if (cancelled) return;
      const p = Math.min((now - t0) / dur, 1);
      apply(from + (to - from) * ease(p));
      if (p < 1) requestAnimationFrame(f);
      else if (done) done();
    })(performance.now());
    return { cancel() { cancelled = true; } };
  }

  // ============================================================================
  // GEOMETRY — one measurement drives every state
  // ============================================================================
  const FRAME = 60;                 // the 60px rhythm
  const DETAIL_TOP = 120;           // art-news view's top; the sliver above it is the site

  const stage = document.getElementById("stage");
  const world = document.getElementById("world");
  const nav = document.getElementById("nav");
  // hoisted above applyStage, which drives all three layers together
  const detailEl = document.getElementById("detail");
  const detailScroll = document.getElementById("detailScroll");
  const detailContent = document.getElementById("detailContent");
  const track = document.getElementById("track");
  const subs = { art: document.getElementById("art"),
                 news: document.getElementById("news"),
                 bio: document.getElementById("bio") };
  // ⚠︎ v4: scoped to [data-section]. It was ".nav a", which now also matches the three
  // Contact anchors — they'd have entered `links` (so paintNav would tint them) and,
  // worse, `order` would gain undefined entries and break every tab index.
  const links = [...document.querySelectorAll(".nav a[data-section]")];
  const order = links.map((a) => a.dataset.section);

  let VH = 0, BAND = 132, LANDING_H = 0;

  function measureGeom() {
    VH = window.innerHeight;
    const navH = nav.getBoundingClientRect().height;
    BAND = FRAME * 2 + navH;            // 60 above the nav, the nav, 60 below it
    LANDING_H = VH - BAND;              // hero height AND the landing→tab travel
    root.style.setProperty("--band", BAND + "px");
    root.style.setProperty("--landing-h", LANDING_H + "px");
    root.style.setProperty("--detail-top", DETAIL_TOP + "px");
  }

  // ============================================================================
  // STATE
  // ============================================================================
  let view = "landing";             // "landing" | "tab"  — the INTENT, set the moment a commit fires
  let detailOpen = false;
  let cxOpen = false;               // contact expander (all its visuals are CSS off .cx-open)
  let current = "art";              // active tab
  let worldY = 0, stageY = 0;
  let worldTween = null, stageTween = null, tabTween = null;

  const stageOpenY = () => -(VH - DETAIL_TOP);

  // reveal progress 0 (landing) → 1 (tab); drives the nav tint and the content fade
  const revealP = () => (LANDING_H ? Math.min(1, Math.max(0, -worldY / LANDING_H)) : 0);

  // current on-screen y of the tab frame's top edge — the live boundary between the
  // carousel region and the tab region. LANDING_H at landing, 0 in tab view, and
  // correct at every point in between, which is what makes mid-lerp routing work.
  const tabTopY = () => LANDING_H + worldY;

  // Tab contents fade out over the last 80% of the return to landing and stay at 0
  // once settled. Driven off POSITION, not tween time — so catching or reversing a
  // lerp mid-flight keeps the fade exactly in step with where the world actually is.
  function paintTrack() {
    const o = Math.min(1, Math.max(0, (revealP() - FADE_FLOOR) / (1 - FADE_FLOOR)));
    track.style.opacity = o;
  }

  // single writer for the world offset: transform + fade + nav tint always agree
  function applyWorld(y) {
    worldY = y;
    world.style.transform = `translateY(${y}px)`;
    paintTrack();
    paintNav();
  }
  // 0 (card closed) → 1 (card fully revealed). Every reveal dynamic keys off this, so
  // they stay in lockstep with where the stage ACTUALLY is — including when the lerp is
  // caught or reversed mid-flight. Position-derived, never tween-time-derived.
  function detailP() {
    const open = stageOpenY();
    return open ? Math.min(1, Math.max(0, stageY / open)) : 0;
  }

  function applyStage(y) {
    stageY = y;
    const p = detailP();
    // SITE: rises, enlarges to --site-zoom-max, blurs to --site-blur-max.
    stage.style.transform = `translateY(${y}px) scale(${1 + (SITE_ZOOM - 1) * p})`;
    // Cleared to "none" at rest so a full-viewport blur layer isn't kept alive for free.
    // Blur runs on its own floor: it reaches 0 at --blur-floor of the reveal, i.e. 60%
    // of the way through the exit, rather than trailing all the way to the end.
    const bp = Math.min(1, Math.max(0, (p - BLUR_FLOOR) / (1 - BLUR_FLOOR)));
    world.style.filter = bp > 0.001 ? `blur(${(SITE_BLUR * bp).toFixed(2)}px)` : "none";
    // CARD: zooms --card-zoom-min → 1. Because (0.95 + 0.05p) >= p for all p <= 1, the
    // card's growing top edge stays tucked behind the rising stage edge the whole way,
    // and the two arrive on the 120px line together.
    detailEl.style.transform = `scale(${CARD_ZOOM + (1 - CARD_ZOOM) * p})`;
  }

  // nav active state = grey, lerped continuously with the horizontal swipe AND
  // ramped by reveal so every link reads black at landing.
  const NAV_FG = [0, 0, 0], NAV_SEL = [148, 148, 148];
  function paintNav() {
    const w = tabW(), pos = w ? track.scrollLeft / w : 0, ramp = revealP();
    links.forEach((a, i) => {
      const close = (1 - Math.min(1, Math.abs(pos - i))) * ramp;
      const c = NAV_FG.map((b, k) => Math.round(b + (NAV_SEL[k] - b) * close));
      a.style.color = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    });
  }

  // tabs are LOCKED at landing and scroll internally in tab view
  function applyView() {
    const inTab = view === "tab";
    for (const el of Object.values(subs)) el.style.overflowY = inTab ? "auto" : "hidden";
  }

  // ============================================================================
  // TAB TRACK — native x-mandatory scroll-snap; JS only reads it
  // ============================================================================
  const tabW = () => track.clientWidth || window.innerWidth;

  function nearestIndex() {
    const max = track.scrollWidth - track.clientWidth;
    if (max <= 0) return 0;
    return Math.max(0, Math.min(order.length - 1, Math.round(track.scrollLeft / tabW())));
  }

  // SETTLE-ON-REST: momentum keeps moving past the last scroll event, so re-measure
  // INSIDE the timeout. Fling events reset the timer, so this lands once, on the
  // rested tab. Per-tab scrollTop is deliberately NOT reset here — tabs keep their
  // last known position across swipes (they only reset on return to landing).
  let settleTimer = 0;
  track.addEventListener("scroll", () => {
    paintNav();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const name = order[nearestIndex()];
      if (name && name !== current) current = name;
    }, 120);
  }, { passive: true });

  // programmatic tab change. Instant = cut (entering from landing, where the tab
  // isn't visible yet so the slide would be wasted). Smooth = the custom lerp,
  // because native behavior:"smooth" has a fixed, untunable duration.
  // a manual swipe during a nav-driven slide takes over: drop the tween, hand the
  // track straight back to native snap from wherever it is
  function releaseTab() {
    if (!tabTween) return;
    tabTween.cancel();
    tabTween = null;
    track.style.scrollSnapType = "";
  }

  function scrollToTab(idx, smooth, done) {
    releaseTab();
    const target = idx * tabW();
    if (!smooth) {
      track.scrollTo({ left: target, behavior: "instant" });
      current = order[idx];
      paintNav();
      if (done) done();
      return;
    }
    current = order[idx];
    track.style.scrollSnapType = "none";   // mandatory snap fights per-frame scrollLeft writes
    const start = track.scrollLeft;
    tabTween = tween(start, target, cssMs("--tab-dur", 500),
      (v) => { track.scrollLeft = v; paintNav(); },
      () => { tabTween = null; track.style.scrollSnapType = ""; paintNav(); if (done) done(); });
  }

  // ============================================================================
  // STATE TRANSITIONS — every one is a commit-lerp on the shared curve
  // ============================================================================
  // Duration scales with the distance actually left to travel, so a lerp caught
  // near its destination finishes quickly instead of crawling through a full --dur.
  function spanDur(from, to, span) {
    if (!span) return DUR;
    return Math.max(DUR * 0.3, DUR * Math.abs(to - from) / span);
  }

  function worldTo(target, done) {
    if (worldTween) worldTween.cancel();          // catch whatever is in flight
    worldTween = tween(worldY, target, spanDur(worldY, target, LANDING_H), applyWorld,
      () => { worldTween = null; if (done) done(); });
  }

  function goTab() {
    if (view === "tab") return;
    T.push({ k: "@goTab", g: arb.state().gestureId, claim: arb.state().gRegion });
    view = "tab";
    arb.consume();                                    // this gesture has had its transition
    applyView();                                  // unlock the tabs NOW so they scroll mid-lerp
    worldTo(-LANDING_H);
  }

  function goLanding() {
    if (view === "landing") return;
    T.push({ k: "@goLanding", g: arb.state().gestureId, claim: arb.state().gRegion });
    view = "landing";
    arb.consume();                                    // this gesture has had its transition
    // tabs stay unlocked through the return so a caught lerp can still be scrolled
    worldTo(0, () => {
      for (const el of Object.values(subs)) el.scrollTop = 0;   // faded + off-screen → invisible
      applyView();
    });
  }

  function stageTo(target, done) {
    if (stageTween) stageTween.cancel();
    stageTween = tween(stageY, target, spanDur(stageY, target, VH - DETAIL_TOP), applyStage,
      () => { stageTween = null; if (done) done(); });
  }

  function openDetail() {
    if (detailOpen) return;
    detailOpen = true;
    detailEl.classList.add("open");
    detailScroll.scrollTop = 0;
    detailScroll.style.overflowY = "auto";
    // Opening is click-driven, so there is no gesture to consume — but a gesture may still be
    // in flight (tap-to-click lands mid-coast) and it would be holding a "carousel" claim.
    // The card is now up; nothing in flight can be a carousel gesture any more. Usually the
    // pause before the click ends the gesture anyway; this closes the case where it doesn't.
    arb.claimRegion("detail");
    requestAnimationFrame(() => stageTo(stageOpenY()));   // click-driven: no gesture to consume
  }

  function closeDetail() {
    if (!detailOpen) return;
    // ⭐ the anchor for every leak counter — the post-close window opens HERE, which is
    // also where `detailOpen` flips and the coast becomes free to reach the deck.
    T.push({ k: "@closeDetail", g: arb.state().gestureId, claim: arb.state().gRegion });
    closeViaHistory();   // keep the URL in step with a gesture-driven close
    detailOpen = false;
    arb.consume();   // spend the gesture HERE, not when the lerp lands: detailOpen flips
                 // immediately, so the next event of this same flick would otherwise fall
                 // through to the tab branch and carry it home too.
    // The card stays display:block (and on top of the cursor) until the tween ends, so a
    // momentum tail would otherwise land on ITS scroller and visibly jitter the content
    // while it is being covered. Lock it for the duration.
    detailScroll.style.overflowY = "hidden";
    stageTo(0, () => {
      detailEl.classList.remove("open");     // inert again
      detailContent.innerHTML = "";
    });
  }

  // ============================================================================
  // GESTURE ARBITER — imported, not reimplemented. See gesture-arbiter.mjs and its
  // test suite; the seven dead ends are each pinned there as a named failing test.
  // ============================================================================
  const arb = createArbiter(
    {
      gestureGap: cssMs("--gesture-gap", 100),
      reverseFrac: cssNum("--gesture-reverse", 0.25),
      repushRun: cssNum("--repush-run", 3),
      repushFloor: cssNum("--repush-floor", 0.2),
      repushArm: cssNum("--repush-arm", 0.25),
      claimRise: cssNum("--claim-rise", 1.5),
      claimFloor: cssNum("--claim-floor", 0.2),
      commitDist: cssNum("--commit-dist", 120),
      commitVel: cssNum("--commit-vel", 1.2),
      commitDistBack: cssNum("--commit-dist-back", 200),
      commitVelBack: cssNum("--commit-vel-back", 1.8),
      debug: cssNum("--gesture-debug", 0) === 1,
    },
    {
      detailOpen: () => detailOpen,
      tabTopY: () => tabTopY(),
      tweenActive: () => !!(stageTween || worldTween),
    }
  );
  let lastT = 0;
  // map a wheel over a horizontal strip onto its scrollLeft; true if consumed
  function mapToCarousel(el, e) {
    const maxLeft = el.scrollWidth - el.clientWidth;
    if (maxLeft <= 0) return false;
    let consumed = false;
    if (e.deltaX) { el.scrollLeft += e.deltaX; consumed = true; }
    const dy = e.deltaY;
    if (dy) {
      const atStart = el.scrollLeft <= 1, atEnd = el.scrollLeft >= maxLeft - 1;
      if (!((dy > 0 && atEnd) || (dy < 0 && atStart))) { el.scrollLeft += dy; consumed = true; }
    }
    return consumed;
  }

  window.addEventListener("wheel", (e) => {
    // NOTE: no "busy" gate. Input is never blocked while a lerp RUNS — scrolling and
    // swiping continue, and a commit in the opposite direction catches the lerp and
    // re-aims it from wherever it currently sits.
    const now = performance.now();
    const dt = now - lastT; lastT = now;

    // The arbiter owns idle-reset AND segmentation; see src/lib/gesture-arbiter.mjs.
    // ⚠︎ state() is read on BOTH sides of feed() so the trace can see a MINT from outside
    // the module — a change in gestureId across feed() is a new gesture, by definition.
    // Both reads are no-ops (and the object is never built) when the trace is off.
    const tBefore = T.on ? arb.state() : null;
    arb.feed({ deltaY: e.deltaY, dt, clientY: e.clientY });
    if (T.on) T.wheel(e, dt, tBefore, arb.state());

    // ---- STATE 3: art-news detail ----
    if (detailOpen) {
      if (!detailEl.contains(e.target)) { e.preventDefault(); return; }   // over the sliver
      // no horizontal case left: the card is a single column, so vertical is the
      // only axis and the native scroller owns it
      if (detailScroll.scrollTop <= 0 && e.deltaY < 0) {                  // beyond the upper bound
        arb.addIntent(-e.deltaY);
        if (arb.meant(arb.intent, -e.deltaY, dt, true) && arb.gestureLive()) closeDetail();
      } else arb.resetIntent();
      return;                                                            // native scroll otherwise
    }

    // ---- REGION: over the carousel ----
    // Tested against the carousel's CURRENT on-screen extent rather than a fixed
    // LANDING_H, so the region stays correct while a lerp is in flight: whatever is
    // under the cursor right now is what responds.
    if (e.clientY < tabTopY()) {
      e.preventDefault();
      // BOTH axes drive horizontal movement here, and a vertical gesture never commits.
      //
      // ⭐ OWNERSHIP, not liveness. Reaching this branch only means the cursor is over the
      // carousel NOW — and "now" is not stable, because tabTopY() moves as the card closes
      // and as the world lerps. A gesture that began over the open card, or down on the tab
      // frame, arrives here mid-coast through no intent of the user's. It does not own the
      // carousel and gets nothing. The event is still preventDefault'd above, so it dies
      // here rather than leaking to native scroll.
      // ⚠︎ RECORDED ON THE GRANT, NOT ON THE PIXELS. A coast that wins ownsCarousel() has
      // leaked, whether or not the deck had room left to move — count the moved pixels and
      // you get a counter that reads 0 at either end of the carousel, and on a cold load
      // before the images size it. `moved` keeps the distinction visible.
      if (arb.ownsCarousel()) {
        const moved = mapToCarousel(carousel, e);
        T.push({ k: ">DECK", via: "region", g: arb.state().gestureId, moved,
                 dx: +e.deltaX.toFixed(2), dy: +e.deltaY.toFixed(2), mom: e.momentum });
      }
      arb.resetIntent();
      return;
    }

    // ---- REGION: over the tab frame, at (or heading to) landing ----
    if (view === "landing") {
      e.preventDefault();
      // Horizontal over the tab frame at landing also browses the deck — a second JS-driven
      // write to the same scroller, and the old momentum gate never covered it. Ownership
      // does: anything born over the open card is excluded, the rest browses as before.
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        if (arb.region() !== "detail") {
          carousel.scrollLeft += e.deltaX;
          // ⚠︎ the SECOND writer to the same scroller, behind a DIFFERENT gate. Tagged
          // separately so the report can show which of the two gates leaked. C collapses
          // these into one unconditional rule.
          T.push({ k: ">DECK", via: "frame", g: arb.state().gestureId,
                   dx: +e.deltaX.toFixed(2), dy: +e.deltaY.toFixed(2), mom: e.momentum });
        }
        return;
      }
      if (e.deltaY > 0) {              // downward → commit into tab view (catches a return lerp)
        arb.addIntent(e.deltaY);
        if (arb.meant(arb.intent, e.deltaY, dt, false) && arb.gestureLive()) goTab();
      } else arb.resetIntent();
      return;
    }

    // ---- REGION: over the tab frame, in tab view ----
    // horizontal is left entirely to the native snap track (no preventDefault); a
    // swipe mid-slide releases the nav tween so the gesture takes over
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { releaseTab(); arb.resetIntent(); return; }
    const sub = subs[current];
    if (sub.scrollTop <= 0 && e.deltaY < 0) {          // at 0%, pulling up → landing
      e.preventDefault();
      arb.addIntent(-e.deltaY);
      if (arb.meant(arb.intent, -e.deltaY, dt, true) && arb.gestureLive()) goLanding();
    } else arb.resetIntent();                                    // otherwise the tab scrolls natively
  }, { passive: false });

  // ---- touch: axis-lock at gesture start ----
  // No hover on touch, so the first few pixels decide the axis for the whole
  // gesture: horizontal browses (native), vertical commits.
  let tsX = 0, tsY = 0, tAxis = null, tDone = false;
  const AXIS_LOCK = 8;              // px before the axis is decided

  window.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    tsX = t.clientX; tsY = t.clientY; tAxis = null; tDone = false;
    // touchstart IS a gesture boundary — and it is also where this gesture stakes its claim,
    // from the finger's own landing point. Same rule as wheel, better signal.
    arb.beginGesture(t.clientY);
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (tDone) return;
    const t = e.touches[0];
    const dx = t.clientX - tsX, dy = t.clientY - tsY;
    if (!tAxis) {
      if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
      tAxis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (tAxis === "x") { releaseTab(); return; }   // horizontal → native carousel / track

    if (detailOpen) {
      if (detailScroll.scrollTop <= 0 && dy > arb.config.commitDistBack && arb.gestureLive()) { tDone = true; closeDetail(); }
      return;
    }
    if (view === "landing") {
      if (-dy > arb.config.commitDist && arb.gestureLive()) { tDone = true; goTab(); }   // forward
      return;
    }
    if (subs[current].scrollTop <= 0 && dy > arb.config.commitDistBack && arb.gestureLive()) { tDone = true; goLanding(); }
  }, { passive: true });

  // ============================================================================  // CONTACT  (v4) — a nav-row expander, NOT a tab.
  // Deliberately not a `.sub`: adding a fourth panel would widen the track and put
  // every tab index, scroll-snap stop and setHeight() measurement back in play. This
  // touches nothing but the nav row, so the gesture arbiter is untouched.
  // Data is real, from content/contact.md (repo manyprojects-co/portfolio @5bce365).
  // ============================================================================
  // Data comes from content/contact.md via Nav.astro's data- attributes — the only
  // surface in the whole CMS with complete data, which is why it got built first.
  const navTrack = document.getElementById("navTrack");
  const cxExtras = document.getElementById("cxExtras");
  const cxToggle = document.getElementById("cxToggle");
  const cxIg = document.getElementById("cxIg");
  const cxMail = document.getElementById("cxMail");
  const cxMailWrap = document.getElementById("cxMailWrap");
  const cxCopied = document.getElementById("cxCopied");
  const cxClose = document.getElementById("cxClose");
  const CX_COPIED_MS = cssMs("--contact-copied-ms", 1200);   // unit-aware — see css-time.ts

  const CONTACT = { email: cxMail.dataset.email || "", instagram: cxIg.href || "" };
  cxMail.title = CONTACT.email;

  // No width pinning any more — "Copied!" is an absolutely-positioned overlay, so it
  // cannot change the extras' width. All this has to do is re-aim an already-open
  // track when the measurement changes (font swap, resize).
  function pinContact() {
    if (cxOpen) navTrack.style.transform = `translateX(${-cxShift()}px)`;
  }

  // How far the track travels. The extras are parked --contact-gap past the track's
  // right edge, so sliding by (their width + that gap) lands their RIGHT edge exactly
  // on the track's right edge — i.e. the same 60 line the rest of the frame uses.
  // The gap term MUST match the CSS `left` offset; both read --contact-gap so they
  // cannot drift. Measured live on every open, which absorbs font load, resize and
  // label changes. A translate does not change getBoundingClientRect().width, so
  // measuring mid-lerp is safe.
  const CX_GAP = parseFloat(getComputedStyle(root).getPropertyValue("--contact-gap")) || 60;
  const cxShift = () => cxExtras.getBoundingClientRect().width + CX_GAP;

  function setContact(open) {
    if (open === cxOpen) return;
    if (open && detailOpen) return;        // no expanding behind an open card
    const d = open ? cxShift() : 0;
    cxOpen = open;
    nav.classList.toggle("cx-open", open); // drives the dim + arms the extras
    navTrack.style.transform = `translateX(${-d}px)`;
    cxToggle.setAttribute("aria-expanded", String(open));
  }

  // Clipboard: navigator.clipboard needs a secure context, which a file:// review
  // build is NOT. Fall back to the execCommand path, and if even that fails, show
  // the address so it can be copied by hand rather than silently doing nothing.
  async function writeClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall through */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:-9999px;opacity:0";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }

  let cxMailTimer = 0;
  async function copyEmail() {
    const ok = await writeClipboard(CONTACT.email);
    // On the failure path show the address instead — the overlay is out of flow and
    // centred, so a longer string costs no layout.
    cxCopied.textContent = ok ? "Copied!" : CONTACT.email;
    cxMailWrap.classList.add("copied");
    clearTimeout(cxMailTimer);
    cxMailTimer = setTimeout(() => cxMailWrap.classList.remove("copied"), CX_COPIED_MS);
  }

  cxToggle.addEventListener("click", (e) => { e.stopPropagation(); setContact(!cxOpen); });
  cxClose.addEventListener("click", (e) => { e.stopPropagation(); setContact(false); });
  cxIg.addEventListener("click", (e) => { e.stopPropagation(); });   // let the anchor open the tab
  cxMail.addEventListener("click", (e) => { e.stopPropagation(); copyEmail(); });

  // Outside-tap closes. CAPTURE phase on purpose: nav links, grid cards and news rows
  // all stopPropagation in the bubble phase, so a bubble listener would never hear
  // them and the group would stay open behind a card. Capture sees every click first.
  document.addEventListener("click", (e) => {
    if (!cxOpen) return;
    // the "contact section" is the toggle plus the extras. ✕ is inside it, so capture
    // skips it and its own handler does the closing — no double-toggle.
    if (cxToggle.contains(e.target) || cxExtras.contains(e.target)) return;
    setContact(false);
  }, true);

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setContact(false); });

  // ============================================================================
  // NAV
  // ============================================================================
  links.forEach((a) => a.addEventListener("click", (e) => {
    e.stopPropagation();
    if (detailOpen) return;
    const name = a.dataset.section, idx = order.indexOf(name);
    if (view === "tab") {
      if (name === current) goLanding();          // tap the active tab → back to landing
      else scrollToTab(idx, true);                // lerp through to the tab
    } else {
      scrollToTab(idx, false);                    // cut (not visible yet), then drop in
      goTab();
    }
  }));

  // tapping the sliver of landing/tab in the 120px gap → back to the previous state
  stage.addEventListener("click", (e) => {
    if (!detailOpen) return;
    e.stopPropagation();
    closeDetail();
  }, true);

  // ============================================================================
  // ============================================================================
  // DETAIL ROUTES — fetch, adopt, and the URL
  //
  // ⭐ THE PORTING HINGE (hooks.md § Detail-route architecture — LOCKED). The sheet has
  // to work two ways from ONE code path:
  //   · IN-SITE CLICK  -> fetch /type/slug/content, inject, run the rise, pushState
  //   · COLD URL LOAD  -> the route already inlined the content; ADOPT it and present
  //                       AT REST, with no rise. A rise is the response to a click, and
  //                       arriving by URL is not a click.
  // No JS at all -> the <a href> loads the pre-rendered route and the sheet is already up.
  //
  // ⚠︎ The partial is `/content`, NOT `/_content` as hooks.md specifies: Astro excludes any
  // src/pages path starting with `_` from routing, so the underscore name builds clean and
  // then 404s at runtime. Same architecture, routable name.
  //
  // ⚠︎ The two markups CANNOT diverge, because the route and the partial render the SAME
  // <Work>/<NewsItem> component — one renderer, not two. v6 built this markup in
  // JavaScript; that generator is deleted, along with the embedded JSON payload it fed on.
  // ============================================================================
  const partialCache = new Map();

  async function loadPartial(path) {
    if (partialCache.has(path)) return partialCache.get(path);
    const res = await fetch(`/${path}/content`, { headers: { Accept: "text/html" } });
    if (!res.ok) throw new Error(`partial ${path}: ${res.status}`);
    const html = await res.text();
    partialCache.set(path, html);   // one fetch per item, cached after
    return html;
  }

  /** The card's bottom ground follows whatever section actually ends the card. */
  const syncTechTail = () =>
    detailEl.classList.toggle("tech-tail", !!detailContent.querySelector(".tech"));

  /** In-site open: fetch, inject, rise, push the URL. */
  async function openPath(path, { push = true } = {}) {
    if (detailOpen) return;
    let html;
    try {
      html = await loadPartial(path);
    } catch {
      window.location.href = `/${path}`;   // fall back to a full navigation
      return;
    }
    detailContent.innerHTML = html;
    syncTechTail();
    refreshElapsed(detailContent);
    if (push) { history.pushState({ detail: path }, "", `/${path}`); pushedByUs = true; }
    openDetail();
  }

  /**
   * COLD LOAD: the server already rendered the sheet into #detailContent and marked
   * #detail `.open .cold`. Present it at its resting position with NO animation, and leave
   * the world at the landing — which is where a close lerps down to.
   */
  function adoptSheet() {
    detailOpen = true;
    detailEl.classList.remove("cold");
    detailScroll.scrollTop = 0;
    detailScroll.style.overflowY = "auto";
    syncTechTail();
    arb.claimRegion("detail");
    applyStage(stageOpenY());     // measured and presented, NOT tweened
  }

  // ---- click wiring. Cards are real links; intercept only the plain left-click, so
  // cmd/ctrl-click, middle-click and "open in new tab" all keep working.
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const hit = e.target.closest?.("[data-detail]");
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    openPath(hit.dataset.detail);
  });

  // ---- the URL is the source of truth for which sheet is open. closeDetail() unwinds it so
  // a GESTURE close updates the URL too; the popstate that produces must not then close it a
  // second time, hence navLock.
  //
  // ⚠️ history.back() IS ONLY SAFE ON AN ENTRY WE PUSHED OURSELVES. Found live on Safari and
  // Chrome alike, 2026-08-14 (JJ): cold-loading /art/<slug> and then swiping out CUT straight
  // to the landing with no lerp. It was never an animation failure — it was a full page
  // navigation. On a cold load the current history entry was created by loading the DOCUMENT,
  // so back() is a cross-document navigation: the browser destroys the page mid-close and
  // reloads / from scratch. Nothing animates because the animating document is gone.
  // Measured: click-in close = 6 distinct transforms, 0 document loads. Cold-URL close = 3
  // transforms, 1 DOCUMENT LOAD. From a fresh tab it navigated off the site entirely.
  //
  // So: back() only when we know we pushed the entry; otherwise rewrite the URL in place and
  // let the tween run. `pushedByUs` deliberately resets to false after any popstate — when in
  // doubt take the branch that CANNOT navigate. Being wrong that way costs one stale history
  // entry; being wrong the other way destroys the document mid-animation.
  let navLock = false;
  let pushedByUs = false;
  function closeViaHistory() {
    if (navLock) return;
    if (!history.state || !history.state.detail) return;   // nothing to unwind
    if (pushedByUs) { navLock = true; history.back(); return; }
    history.replaceState({}, "", "/");                     // same document, no navigation
  }

  window.addEventListener("popstate", () => {
    const path = location.pathname.replace(/^\/+|\/+$/g, "");
    const wantsDetail = /^(art|news)\/.+/.test(path);
    // after a pop we are on an entry that existed before this handler ran, and we cannot know
    // whether it is same-document. Assume not — see the note on closeViaHistory.
    pushedByUs = false;
    if (wantsDetail && !detailOpen) openPath(path, { push: false });
    else if (!wantsDetail && detailOpen) { navLock = true; closeDetail(); navLock = false; }
    else navLock = false;
  });

  // ---- `timeElapsed` is relative to now and was baked at build time. Refresh it so a page
  // built in August doesn't still read "3d" in December. See lib/format.ts.
  function refreshElapsed(scope) {
    for (const el of (scope || document).querySelectorAll("[data-elapsed]")) {
      const d = el.getAttribute("data-elapsed");
      if (d) el.textContent = timeElapsed(d);
    }
  }
  refreshElapsed();

  // ============================================================================
  // INIT + RESIZE
  // ============================================================================
  function init() {
    pinContact();                       // BEFORE measureGeom: pinning sets the nav's
    measureGeom();                      // final line width, and navH feeds BAND
    // ⭐ the ADOPT half of the hinge — a detail route rendered the sheet server-side
    const cold = detailEl.dataset.coldOpen;
    if (cold) {
      history.replaceState({ detail: cold }, "", location.pathname);
      pushedByUs = false;          // came from a document load — back() would leave the page
      adoptSheet();
    }
    applyWorld(view === "tab" ? -LANDING_H : 0);
    if (!detailOpen) applyStage(0);   // adoptSheet already positioned it
    applyView();
    scrollToTab(order.indexOf(current), false);
    paintNav();
    T.bind();                          // HUD + keybindings; a no-op unless ?trace=1
  }
  init();

  // Inter arrives with display:swap, so the pin above was measured against the
  // fallback face. Re-pin once the real face lands, then re-measure the band in case
  // the nav's line height moved with it.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { pinContact(); measureGeom(); });
  }

  // ⚠︎ K — ON iOS THE URL BAR CAN CUT A TRANSITION.
  // iOS Safari fires `resize` when the URL bar collapses, and it collapses DURING a scroll
  // gesture. So a gesture that commits a transition *and* collapses the bar used to cancel
  // its own lerp and hard-snap to the end state — the transition visibly cut. The handler's
  // logic is right for a genuine resize; on iOS a URL-bar collapse is not one, and it lands
  // at the worst possible moment.
  //
  // ⚠︎ INVISIBLE TO THE CURRENT TEST DISCIPLINE — "a cut satisfies an end-state assertion
  // perfectly." Verify by sampling frames DURING the transition, never after a wait.
  //
  // The discriminator is HEIGHT-ONLY + A TWEEN IN FLIGHT. A window resized with a mouse
  // almost always changes width too, and a device rotation changes both — so neither takes
  // this path. Re-aiming is not a new mechanism: worldTo()/stageTo() already tween FROM the
  // current position, which is exactly "re-aim at the new geometry without stopping".
  //
  // ⚠︎ Known remainder, deliberately NOT fixed here: the same collapse AT REST still jumps,
  // because applyWorld(-LANDING_H) moves when LANDING_H does. Fixing that means keying the
  // geometry on svh/dvh/visualViewport — which changes what measures LANDING_H, and
  // LANDING_H feeds revealP(), so it changes every reveal dynamic. Bigger, and separate.
  let lastW = window.innerWidth, lastH = window.innerHeight;

  window.addEventListener("resize", () => {
    const w = window.innerWidth, h = window.innerHeight;
    const heightOnly = w === lastW && h !== lastH;
    lastW = w; lastH = h;

    if (heightOnly && (worldTween || stageTween)) {
      measureGeom();
      // RE-AIM, don't cancel. Contact is left alone: its geometry is the nav's line width,
      // which is width-driven, so a height-only change has not invalidated it.
      if (worldTween) worldTo(view === "tab" ? -LANDING_H : 0);
      if (stageTween) stageTo(detailOpen ? stageOpenY() : 0);
      return;                                     // snap offset is width-driven: nothing to do
    }

    // a genuine resize invalidates every in-flight target — land on the current state instead
    if (worldTween) { worldTween.cancel(); worldTween = null; }
    if (stageTween) { stageTween.cancel(); stageTween = null; }
    setContact(false);                            // an open group is stale geometry
    measureGeom();
    applyWorld(view === "tab" ? -LANDING_H : 0);
    applyStage(detailOpen ? stageOpenY() : 0);
    scrollToTab(order.indexOf(current), false);   // px snap offset changes with width
  });
}
