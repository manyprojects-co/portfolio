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
  let ease = easeFromToken();

  /**
   * ⚠︎ UNIT-AWARE, and it must stay that way. v6 used a bare parseFloat here, which is
   * correct only while nothing rewrites the CSS. Astro's production minifier rewrites
   * `500ms` to `.5s` — same duration, different string — and a bare parseFloat then
   * returns 0.5, turning every lerp into a cut and the gesture-gap into 0.1ms.
   * Full write-up in src/lib/css-time.ts.
   */
  const cssMs = (name, fallback) =>
    parseCssTime(getComputedStyle(root).getPropertyValue(name), fallback);
  let DUR = cssMs("--dur", 500);

  const cssNum = (name, fallback) => {
    const v = parseFloat(getComputedStyle(root).getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  // v3 reveal dynamics. ⚠︎ `let`, not `const`, ONLY so retune() can re-read them in dev —
  // see retune() for why that is not a nicety. Nothing reassigns them at runtime.
  let SITE_ZOOM  = cssNum("--site-zoom-max", 1.1);
  let SITE_BLUR  = cssNum("--site-blur-max", 50);
  let CARD_ZOOM  = cssNum("--card-zoom-min", 0.95);
  let FADE_FLOOR = cssNum("--fade-floor", 0.2);
  let BLUR_FLOOR = cssNum("--blur-floor", 0.4);
  let CARD_BLUR    = cssNum("--card-blur", 1);
  let CARD_BLUR_IN = cssNum("--card-blur-in", 0.45);
  let VEIL_MODE    = cssNum("--card-veil-mode", 1);
  let VEIL_OP      = cssNum("--card-veil-op", 0.9);
  // give (D) — see the GIVE section for what these two numbers mean geometrically
  let GIVE_MAX   = cssNum("--give-max", 0.5);
  let GIVE_EASE  = cssNum("--give-ease", 2);
  let TOUCH_COMMIT = cssNum("--touch-commit", 0.3);   // D2: fraction of the traverse
  let TOUCH_VEL    = cssNum("--touch-vel", 0.5);      // ...or this flick, px/ms
  // ⏪ ROLLBACK SWITCH — see "EDGE-STRICT" below. 0 restores the pre-2026-08-18 behaviour
  // exactly, at both boundaries. Live-tunable: flip it in global.css and retune() picks it up
  // without a reload, so it can be judged by feel A/B rather than by argument.
  let EDGE_STRICT = cssNum("--edge-strict", 1) === 1;
  let BOUNCE_MAX  = cssNum("--bounce-max", 48);     // px of travel  (HOW FAR)
  let BOUNCE_DIST = cssNum("--bounce-dist", 300);   // px of pull    (HOW LONG)
  // ⏪ ROLLBACK SWITCH for the landing's two edges. 0 restores the bare 120px threshold.
  let LANDING_GIVE = cssNum("--landing-give", 1) === 1;
  // card-native egress — see § EGRESS. A TIME CONSTANT, not a duration: each frame closes
  // (1 - e^(-dt/τ)) of the remaining distance. ~95% of the travel is gone after 3τ.
  let CARD_EGRESS_TAU = cssMs("--card-egress-tau", 70);

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
  const cardBlur = document.getElementById("cardBlur");
  // Rollback at init, not just on retune(): --card-blur: 0 must cost nothing on a cold
  // load too, and a promoted-but-transparent layer is not nothing.
  if (cardBlur && !cssNum("--card-blur", 1)) cardBlur.classList.add("off");
  if (cardBlur && !cssNum("--card-veil-mode", 1)) cardBlur.classList.add("solid");
  const nav = document.getElementById("nav");
  // hoisted above applyStage, which drives all three layers together
  const detailEl = document.getElementById("detail");
  const detailScroll = document.getElementById("detailScroll");
  const detailSpacer = document.getElementById("detailSpacer");   // the sliver, once open
  const detailContent = document.getElementById("detailContent");
  const track = document.getElementById("track");
  // ⚠︎ DECLARED EXPLICITLY. Until A this was never declared at all — the wheel handler's
  // two references resolved to `window.carousel`, the global a browser creates for any
  // element with an `id`. It worked, silently, and would have broken the moment anything
  // else defined that name. A needs the element for measurement anyway.
  const carousel = document.getElementById("carousel");
  const subs = { art: document.getElementById("art"),
                 news: document.getElementById("news"),
                 bio: document.getElementById("bio") };
  // ⚠︎ v4: scoped to [data-section]. It was ".nav a", which now also matches the three
  // Contact anchors — they'd have entered `links` (so paintNav would tint them) and,
  // worse, `order` would gain undefined entries and break every tab index.
  const links = [...document.querySelectorAll(".nav a[data-section]")];
  const order = links.map((a) => a.dataset.section);

  let VH = 0, BAND = 132, LANDING_H = 0, DECK_H = 0;

  function measureGeom() {
    VH = window.innerHeight;
    const navH = nav.getBoundingClientRect().height;
    BAND = FRAME * 2 + navH;            // 60 above the nav, the nav, 60 below it
    LANDING_H = VH - BAND;              // hero height AND the landing→tab travel
    root.style.setProperty("--band", BAND + "px");
    root.style.setProperty("--landing-h", LANDING_H + "px");
    root.style.setProperty("--detail-top", DETAIL_TOP + "px");
    /* ⭐ THE MEASURED viewport height, for layout that must reach the card's floor.
     * The sticky art column sizes itself to end --frame-margin above the card's bottom
     * edge, and `100vh` is the wrong number for that on iOS: it means the LARGEST
     * viewport (URL bar collapsed) and does not change when the bar is showing, so the
     * column would overhang. `dvh` moves constantly instead, which reflows mid-scroll.
     * This is the same VH the gesture system uses, re-measured on exactly the same
     * events — including the height-only resize K added for the iOS URL bar. */
    root.style.setProperty("--vh-live", VH + "px");
    // ⭐ A: the deck's own height — the artwork band, not the hero.
    // ⚠︎ MEASURED HERE, ON PURPOSE, AND NOWHERE ELSE. The obvious implementation is a
    // getBoundingClientRect() in the wheel handler, and that is a forced layout read in a
    // handler that also WRITES scrollLeft — layout thrash on every event of every flick.
    // The carousel's HEIGHT only changes on resize and font-load, both of which land here;
    // its POSITION moves with worldY, which JS already tracks. So it is measured once and
    // the per-event test stays a single comparison, exactly as tabTopY() does it.
    // ⚠︎ Read AFTER --landing-h is set: `.artwork` has `max-height: calc(--landing-h - 80px)`,
    // so on a short viewport the band depends on the value set two lines above.
    DECK_H = carousel ? carousel.getBoundingClientRect().height : 0;
    measureBioStack();
    // ⚠︎ the contact extras' width is cached, and THIS is one of the two places it is
    // refreshed (the other is pinContact). A genuine resize also runs setContact(false),
    // so a stale value can never be used to re-aim — but it would be used by the NEXT
    // open, which is exactly the case this line covers.
    measureContact();
  }

  /**
   * ⭐ THE BIO'S BREAKPOINT IS MEASURED, NOT DECLARED (JJ, 2026-08-23).
   *
   * JJ: "have the bio breakpoint adjust to the measurement of the longest entry instead of
   * shrinking the column width — I'd like to avoid multi-line entries."
   *
   * ⛔ A MEDIA QUERY CANNOT DO THIS. It knows the viewport; it cannot know how wide the
   * longest exhibitions row wants to be. That width depends on the content, the font and
   * the type size, so the threshold has to be computed from the rendered text — which is
   * exactly what this file already does for --band (measures the nav) and --vh-live.
   * So the bio stacks on a CLASS this function sets, not on a `@media` rule.
   *
   * ⚠︎ THE READ IS A FORCED LAYOUT, AND IT BELONGS HERE AND NOWHERE ELSE. Same rule as
   * DECK_H above: measureGeom() runs on load, on resize and on `document.fonts.ready` —
   * every event that can change the answer — so the cost is paid a handful of times rather
   * than per frame. Never move this into a scroll or wheel path.
   *
   * ⚠︎ `max-width: none` MATTERS. .about-col2's track is fit-content(--art-main-max), so
   * without lifting the cap this would measure 480 forever and the threshold would never
   * move. We want the width the content WANTS, not the width it is allowed.
   */
  function measureBioStack() {
    const col2 = document.querySelector(".about-col2");
    if (!col2) return;
    const prevW = col2.style.width, prevMax = col2.style.maxWidth;
    col2.style.width = "max-content";
    col2.style.maxWidth = "none";
    const listW = Math.ceil(col2.getBoundingClientRect().width);
    col2.style.width = prevW;
    col2.style.maxWidth = prevMax;
    // the two-column layout needs: sticky column + gap + the longest entry + both margins
    const sideW = cssNum("--art-side-w", 300);
    const gap = cssNum("--art-col-gap", 32);
    const need = sideW + gap + listW + FRAME * 2;
    root.style.setProperty("--bio-list-w", listW + "px");
    root.classList.toggle("bio-stacked", window.innerWidth < need);
  }

  /**
   * Bottom edge of the deck region, in viewport coordinates.
   * The carousel is centred in the hero, and the hero's top edge on screen is worldY — so
   * the band runs from worldY + (LANDING_H - DECK_H)/2 for DECK_H px, and this is its
   * lower edge. Moves with the world exactly as tabTopY() does, so the region stays correct
   * mid-lerp: whatever is under the cursor RIGHT NOW is what responds.
   * ⚠︎ Falls back to tabTopY() if the carousel is missing or unmeasurable (an empty
   * `featured` set), which restores v6's whole-hero behaviour rather than collapsing the
   * region to a sliver around the vertical centre.
   */
  const deckBottomY = () =>
    DECK_H > 0 ? worldY + (LANDING_H + DECK_H) / 2 : tabTopY();

  // ============================================================================
  // STATE
  // ============================================================================
  let view = "landing";             // "landing" | "tab"  — the INTENT, set the moment a commit fires
  let detailOpen = false;
  let cxOpen = false;               // contact expander (all its visuals are CSS off .cx-open)
  let current = "art";              // active tab
  let worldY = 0;
  let worldTween = null, tabTween = null;


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
  /* ⭐ card-native (2026-09-24): applyStage() and detailP() are GONE. The card reveal —
   * stage rise + scale, sheet scale, veil opacity — is a CSS scroll-driven animation on
   * #detail's own scroll timeline (global.css § ART-NEWS DETAIL VIEW). Position-derived by
   * construction, and the position is the compositor's. The 2026-08-18 blur note that lived
   * here is preserved in git; --site-blur-max / --blur-floor are declared and unread. */

  // nav active state = grey, lerped continuously with the horizontal swipe AND
  // ramped by reveal so every link reads black at landing.
  const NAV_FG = [0, 0, 0], NAV_SEL = [148, 148, 148];
  /**
   * ⚠︎ HOT PATH. `applyWorld` calls this, and applyWorld runs on every touchmove of a vertical
   * drag and every frame of a tween. `tabW()` and `track.scrollLeft` are LAYOUT READS, taken
   * immediately after `world.style.transform` was written — i.e. a forced synchronous layout,
   * per event, plus a colour write per link.
   *
   * ⭐ WHY THE CACHE IS SAFE: during a vertical touch drag the horizontal axis is locked out
   * (`tAxis === "y"` returns before `releaseTab()`), so neither the track's scroll position nor
   * its width can change for the life of the gesture. Read once at axis lock, reuse, drop on
   * release. ⛔ Never cache outside a locked vertical drag.
   *
   * ⚠︎ This is why the horizontal tab swipe feels smoother than the vertical drive and always
   * will: the deck is native scroll-snap and runs on the compositor with no JS at all. The
   * vertical axis is hand-rolled by design (`hooks.md § Motion audit`) — the gap can be
   * narrowed, not closed.
   */
  let navCache = null;      // { w, pos } while a vertical touch drag owns the gesture
  const navLast = new Int32Array(links.length).fill(-1);   // last colour written per link

  function paintNav() {
    const w = navCache ? navCache.w : tabW();
    const pos = navCache ? navCache.pos : (w ? track.scrollLeft / w : 0);
    const ramp = revealP();
    /**
     * ⭐ SKIP THE WRITE, NOT THE MATH. This runs on every touchmove and every tween frame, and
     * the expensive part is `a.style.color =` (a style invalidation per link), not the three
     * multiplications. On a slow drag `revealP()` moves ~0.001 per event and the ROUNDED
     * 8-bit channels are usually identical, so most of those writes changed nothing.
     *
     * ⛔ The first cut quantised the INPUTS (pos, ramp) instead and was wrong: `close` is
     * their product, so a bucket that looks fine in isolation still straddles a rounding
     * boundary — measured 28,783 visibly-different frames skipped across a ramp sweep.
     * ⚠︎ Comparing the OUTPUT is exact by construction. There is no threshold to get wrong.
     */
    for (let i = 0; i < links.length; i++) {
      const close = (1 - Math.min(1, Math.abs(pos - i))) * ramp;
      const r = Math.round(NAV_FG[0] + (NAV_SEL[0] - NAV_FG[0]) * close);
      const g = Math.round(NAV_FG[1] + (NAV_SEL[1] - NAV_FG[1]) * close);
      const b = Math.round(NAV_FG[2] + (NAV_SEL[2] - NAV_FG[2]) * close);
      const packed = (r << 16) | (g << 8) | b;
      if (packed === navLast[i]) continue;
      navLast[i] = packed;
      links[i].style.color = `rgb(${r}, ${g}, ${b})`;
    }
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
    giveWorld.cancel();
    giveLanding.cancel(); landAcc = 0;   // its travel is the lerp's head start
    T.push({ k: "@goTab", g: arb.state().gestureId, claim: arb.state().gRegion });
    view = "tab";
    arb.consume();                                    // this gesture has had its transition
    applyView();                                  // unlock the tabs NOW so they scroll mid-lerp
    worldTo(-LANDING_H);
  }

  function goLanding() {
    if (view === "landing") return;
    // ⭐ .cancel(), NOT .release(). worldTo() tweens FROM the live worldY, so the px the give has
    // already travelled become the head start of the lerp — and spanDur shortens the
    // duration to match. Springing back first would be a visible hitch at the commit.
    giveWorld.cancel();
    T.push({ k: "@goLanding", g: arb.state().gestureId, claim: arb.state().gRegion });
    view = "landing";
    arb.consume();                                    // this gesture has had its transition
    // tabs stay unlocked through the return so a caught lerp can still be scrolled
    worldTo(0, () => {
      for (const el of Object.values(subs)) el.scrollTop = 0;   // faded + off-screen → invisible
      applyView();
    });
  }

  // ============================================================================
  // GIVE (D) — the elastic at the tab → landing boundary
  // ============================================================================
  /**
   * ⭐ WHAT THIS REPLACES. `interaction-changes.md`, TAB VIEW: pulling up at scrollTop 0
   * used to hit a hard edge, accumulate 200px of INVISIBLE intent, then teleport into a
   * lerp. JJ: "did not feel intuitive." ⚠︎ The browser was ALREADY drawing an elastic
   * there — `overscroll-behavior: contain` blocks chaining but preserves the local bounce
   * — but one fully decoupled from the threshold, so it told you nothing. This is not
   * "add give": it is REPLACE A MEANINGLESS GIVE WITH A COUPLED ONE.
   *
   * ⭐ NOT A NEW RENDER PATH, and that is the whole reason it is cheap. `applyWorld()` is
   * a single writer over one scalar, and `revealP()` is `-worldY / LANDING_H` — so writing
   * worldY during the give fades the tab contents (`paintTrack`) and ramps the nav tint
   * (`paintNav`) for free, in step. The give IS a preview of the commit, not a decoration
   * beside it.
   *
   * ⛔ GIVE CHANGES THE FEEDBACK, NOT THE GATE. The commit still fires mid-gesture at
   * --commit-dist-back, exactly as before. Moving the commit to RELEASE is `J`, a separate
   * change; `motion-fork-brief.md` is explicit that two loosenings must not land together.
   */

  /**
   * Pulled px → px of give. Decelerating, and it comes to rest EXACTLY at the commit point.
   *
   *   give(u) = CEIL * (1 - (1-u)^EASE),  u = pulled / commitDistBack,  CEIL = MAX * dist
   *
   * ⭐ WHY THESE TWO DEFAULTS ARE NOT ARBITRARY. The slope at u=0 is `EASE * MAX`, so at
   * --give-max 0.5 / --give-ease 2 the give starts at EXACTLY 1:1 with your input and
   * decelerates to a standstill at the threshold. It never outruns the gesture (which
   * would read as the page running away) and it never simply stops short (which would read
   * as a wall). "It gets heavier, it stops, and that is when it goes."
   *
   * ⚠︎ Keyed off the COMMIT DISTANCE, not off LANDING_H. `motion-fork-brief.md § G` warns
   * that a px→px curve cannot be universal because the two boundaries have different spans
   * — but they share a threshold, so scaling to the threshold satisfies the same
   * requirement and stays true when E reuses this at the card.
   *
   * ⚠︎ `dist` IS A PARAMETER, and it has to be. The back boundaries commit at
   * --commit-dist-back (200) and the forward one at --commit-dist (120); hardcoding the
   * former would leave the landing's give still travelling at ~0.4 slope when the commit
   * fires, which reads as the view running away rather than as a gate being reached.
   * ⚠︎ This is a piece of `§ G` arriving early — the curve is now genuinely per-threshold
   * rather than per-boundary. G itself (collapsing 120/200 to one number) is untouched.
   *
   * `maxFrac` exists for the DEAD-END bounce, which has no gate to make legible and so wants
   * a shorter, non-committal travel.
   *
   */

  /**
   * The DEAD END's own curve — same shape, two independent numbers.
   *
   * ⭐ WHY IT IS NOT `giveOf`. For a real give, expressing the ceiling as a FRACTION of the
   * commit threshold is the whole point: the travel and the gate stay locked together, which
   * is what makes the gate legible. A dead end has no gate, so that coupling buys nothing and
   * costs the ability to tune. Keyed to --commit-dist (120) the bounce was ~94% spent by 90px
   * of pull — it arrived at its ceiling almost at once and the rest of the gesture did
   * nothing. And a fraction-of-dist ceiling meant lengthening the pull SILENTLY RAISED the
   * travel too (30px → 75px), which is precisely the conflation this separation removes.
   *
   *   --bounce-max   px of travel   HOW FAR it goes
   *   --bounce-dist  px of pull     HOW LONG it takes to get there
   *   opening slope = --give-ease × max / dist   (2 × 48 / 300 = 0.32 today)
   */
  const bounceOf = (pulled) =>
    BOUNCE_MAX * (1 - Math.pow(1 - Math.min(1, Math.max(0, pulled / BOUNCE_DIST)), GIVE_EASE));
  function giveOf(pulled, dist, maxFrac = GIVE_MAX) {
    const u = Math.min(1, Math.max(0, pulled / dist));
    return maxFrac * dist * (1 - Math.pow(1 - u, GIVE_EASE));
  }

  /**
   * ⭐ ONE IMPLEMENTATION, TWO BOUNDARIES. `motion-fork-brief.md § G`: "one threshold, one
   * universal curve, both directions." Copying this per boundary is how the two would drift.
   *
   *   busy()    a lerp owns the scalar right now — give must not write underneath it
   *   at(px)    write the scalar, `px` past its rest position
   *   back()    spring home (the caller supplies the tween, so spanDur stays per-boundary)
   *   map(acc)  accumulated px → px of give. SIGNED where a boundary has two directions.
   */
  function createGive({ busy, at, back, map }) {
    let on = false, timer = 0;
    const release = () => {
      clearTimeout(timer);
      if (!on) return;
      on = false;
      if (busy()) return;              // a commit already took the scalar
      back();
    };
    return {
      release,
      /** ⛔ ASK THIS BEFORE ACCUMULATING. drive() silently no-ops while blocked, so a caller
       *  banking into its own accumulator will bank a whole blocked window and then JUMP.
       *  That was the landing's first attempt; see `hooks.md`. */
      busy,
      /** the give's travel became the lerp's opening distance — do NOT spring back */
      cancel() { on = false; clearTimeout(timer); },
      drive(pulled) {
        // ⛔ ONE WRITER. Give is this project's first deliberate SECOND writer for these
        // scalars, and a lerp in flight outranks it. This is the drift risk P0 exists for.
        //
        // ⚠︎ KNOWN NIT, LEFT DELIBERATELY (2026-08-18): a re-push DURING the spring-back
        // gets no give until the spring lands — a dead window of spanDur's 30% floor,
        // ~150ms. Letting give cancel the tween would fix it, but a tween here is not
        // always the spring-back (goTab's forward lerp also runs in tab view), so the
        // rule has to distinguish them. Small, real, and not worth bundling into the
        // change that answers "does coupled give feel right."
        if (busy()) return;
        on = true;
        clearTimeout(timer);
        // ⚠︎ "Release" on wheel is silence, and --gesture-gap is already this project's
        // definition of a gesture ending. Deliberately NOT a new number.
        timer = setTimeout(release, arb.config.gestureGap);
        at(map(pulled));
      },
    };
  }

  /**
   * ── EDGE-STRICT (2026-08-18, JJ) — one gesture, one action, AT BOTH BOUNDARIES ──────
   *
   * ⭐ THE ASYMMETRY THIS REMOVES, as JJ described it: a flick from mid-CARD scrolls to the
   * top, and the arriving momentum BOUNCES — you need a second push to close. The identical
   * flick from mid-TAB scrolled to the top and went straight through to the landing. Same
   * gesture, two answers.
   *
   * ⭐ IT IS THE SAME DEFECT, AND IT WAS NEVER REPORTED, because at the tab it reads as a
   * feature ("seamless with enough force") while at the card it was logged as the overshoot
   * bug. Branch 1 fixed it at the card with `spendOnNativeScroll()`; the tab branch simply
   * never got the call. This is that call, plus the piece the card was getting by luck.
   *
   * ⚠︎ THE LUCK, NAMED. Both edges used to `preventDefault()` UNCONDITIONALLY, so a spent
   * arrival should hard-stop, not bounce — the card appears to bounce only because macOS has
   * already begun its rubber-band before `scrollTop` reaches 0, and an in-flight bounce
   * survives a later preventDefault. That is platform behaviour, not design, and there is no
   * reason to expect it to hold on Chrome, on Windows, or next release. So: when the gesture
   * is spent we now decline to preventDefault at all, and the scroller's own
   * `overscroll-behavior: contain` bounce plays deliberately.
   *
   * ⏪ ROLLBACK: `--edge-strict: 0` in global.css. That restores the unconditional
   * preventDefault AND drops the tab's spendOnNativeScroll — i.e. exactly today's behaviour
   * — and retune() applies it live, so the two can be compared back-to-back in one session.
   * ⛔ It does NOT touch the CARD's spendOnNativeScroll: that is Branch 1's landed overshoot
   * fix, pinned by tests, and not part of this experiment.
   *
   * ⚠︎ TWO PREDICATES, NOT ONE, AND THE DIFFERENCE IS LOAD-BEARING. Collapsing them looks
   * tidier and silently puts Branch 1's overshoot back at `--edge-strict: 0`: the CARD's
   * `!scrollSpent()` gate is a landed, test-pinned fix and must hold at every setting. Only
   * the TAB's copy of that gate is the experiment.
   */
  /** tab → landing. The same rule, but only while the experiment is on. */
  const tabLive  = () => arb.gestureLive() && (!EDGE_STRICT || !arb.scrollSpent());
  /** may we take the edge from the browser? In rollback we always did. */
  const holdEdge = (live) => live || !EDGE_STRICT;

  /** D — tab → landing. worldY rests at -LANDING_H; give walks it back toward 0. */
  const giveWorld = createGive({
    busy: () => !!worldTween || view !== "tab",
    at: (px) => applyWorld(-LANDING_H + px),
    back: () => worldTo(-LANDING_H),
    map: (a) => giveOf(a, arb.config.commitDist),   // G: one threshold, both directions
  });


  /**
   * ── THE LANDING'S TWO EDGES — REBUILT (2026-08-18, JJ) ─────────────────────────────
   *
   * Down commits into tab view, so it gets the coupled give keyed to --commit-dist (120 —
   * NOT the 200 the back boundaries use). Up is a true dead end: nothing is above the
   * landing, so it gets a shorter, non-committal bounce.
   *
   * ⚠︎ THE BOUNCE HAS TO BE OURS. Every other dead end here is a real scroller, so
   * `overscroll-behavior: contain` draws it. At the landing nothing scrolls at all
   * (`html, body { overflow: hidden }`), so there is no scroller to hand the edge back to.
   *
   * ⭐ SIGNED, ONE INSTANCE. Two gives over one scalar would each have to spring the other
   * back before starting, and `busy()` would block the new direction for the whole spring.
   * One signed accumulator makes a reversal just the number crossing zero.
   *
   * 🐞 THIS IS THE SECOND ATTEMPT. The first shipped two defects with ONE cause — it banked
   * into `landAcc` even while the give was blocked, so the accumulator survived its own
   * blocked window and jumped when it unblocked. Both guards below exist for that; see
   * `hooks.md § The landing's two edges`.
   *
   * ⏪ ROLLBACK: `--landing-give: 0`, applied live by retune().
   */
  let landAcc = 0;      // signed px pulled at the landing. + = toward the tab, − = dead end.

  const giveLanding = createGive({
    busy: () => !!worldTween || view !== "landing" || detailOpen,
    at: (px) => applyWorld(px),
    back: () => { landAcc = 0; worldTo(0); },
    map: (a) => a >= 0
      ? -giveOf(a, arb.config.commitDist)                        // toward the tab
      : bounceOf(-a),                                            // the dead end above
  });

  /**
   * The landing's whole vertical answer, shared by BOTH regions — over the deck and below it
   * — so the two cannot drift.
   */
  function landingVertical(e, dt) {
    if (!LANDING_GIVE) {                       // ⏪ the pre-give behaviour, exactly
      if (e.deltaY > 0) {
        arb.addIntent(e.deltaY);
        if (arb.meant(arb.intent, e.deltaY, dt, false) && arb.gestureLive()) goTab();
      } else arb.resetIntent();
      return;
    }
    const live = arb.gestureLive() && (!EDGE_STRICT || !arb.scrollSpent());
    /* ⭐ GIVE FOLLOWS THE FINGER, NOT THE COAST (2026-08-18, JJ).
       Reported: "on upper-boundary overscroll the landing moves up slightly, then pauses and
       only settles after momentum."

       Both halves are real. It PINS because the dead-end ceiling is small — 30px at
       --bounce-max 0.25, and the curve is ~94% there by 90px pulled, so a flick delivering
       300-800px reaches it in about three events. It then HANGS because release() is gated on
       --gesture-gap silence, and momentum keeps arriving and clearing the timer, so the spring
       cannot run until the coast has fully died.

       ⭐ `motion-fork-brief.md § J` predicted precisely this: "wheel has no release event;
       without a momentum signal 'release' means silence past --gesture-gap, i.e. ~100ms AFTER
       momentum fully decays. Give would stretch and hang." Branch 1 landed the signal, so the
       give can now resolve when the FINGER leaves rather than when the stream goes quiet.
       A give is feedback about what your hand is doing; once your hand is off, it is done.

       ⚠︎ The commit path is deliberately left intact below — a hard flick must still be able
       to enter the tab. Only the GIVE resolves early.
       ⭐ BOTH ENGINES NOW. `arb.coastLikely()` is exact on Chrome (`e.momentum`) and, on
       Safari and Firefox, a deliberately LATE read of sustained clock-regularity — ~83ms of
       evidence. ⛔ UNSCORED on the flagless side; see `coastRun` in the arbiter. It is
       allowed to be wrong because both failure modes are cosmetic: a false coast springs the
       give back early, a false finger is exactly today's hang. ⛔ It gates no transition.
       ⚠︎ giveWorld still releases on silence (giveStage is gone with card-native). Less visible because those
       boundaries usually commit at 200px rather than hanging. Not changed here. */
    if (arb.coastLikely()) {
      landAcc = 0;
      giveLanding.release();
      if (e.deltaY > 0) {
        arb.addIntent(e.deltaY);
        if (live && arb.meant(arb.intent, e.deltaY, dt, false)) goTab();
      } else arb.resetIntent();
      return;
    }
    /* ⛔ GUARD 1 — NEVER BANK WHILE THE GIVE CANNOT ACT. `drive()` no-ops when busy, so
       accumulating through a blocked window and applying the total afterwards writes a
       position built from events the user has long since finished making. That is a jump
       generator, and it is exactly what shipped and got rolled back. Zero it instead. */
    if (!live || giveLanding.busy()) { landAcc = 0; arb.resetIntent(); return; }
    landAcc += e.deltaY;
    if (e.deltaY > 0) {
      arb.addIntent(e.deltaY);
      if (arb.meant(arb.intent, e.deltaY, dt, false)) { goTab(); return; }
    } else {
      arb.resetIntent();                       // pulling up can never commit; nothing is up there
    }
    giveLanding.drive(landAcc);
  }

  // ============================================================================
  // THE CARD — native (card-native, 2026-09-24). MP_CMS_CF/native-snap-spike-brief.md § 1b
  //
  // #detail is a full-viewport snap scroller above the stage: scrollTop 0 = closed, max
  // scroll = open (the sheet's top on the 120 line). JS does three things and nothing else:
  //   open   → detail.scrollTo({ top: max })     smooth via CSS `scroll-behavior`
  //   close  → detail.scrollTo({ top: 0 })       same
  //   settle → on `scrollend`, if it rested at 0, finalise (URL, content, display:none)
  // A gesture close is the snap itself; it needs no JS until it has rested. No tween, no
  // give, no arbiter: the wheel and touch handlers return before doing anything while the
  // card is open, and the scroller's own latching + `scroll-snap-stop: always` are the
  // one-gesture-one-action rule.
  // ⛔ NO `behavior: "smooth"` IN THESE CALLS — it would override the CSS and silently defeat
  // the reduced-motion rule. `behavior: "instant"` is the only value ever passed.
  // ============================================================================
  const cardMax = () => detailEl.scrollHeight - detailEl.clientHeight;   // = the open stop
  /** why the next rest-at-0 is happening: null = a gesture (unwind the URL), "history" = a
   *  popstate already moved the URL (do NOT unwind), "ui" = sliver/Escape (unwind). */
  let closeCause = null;

  function openDetail() {
    if (detailOpen) return;
    detailOpen = true;
    closeCause = null;
    cardSettled = false;
    // WARM's measurement: press → reveal start. Harmless if no mark exists (a popstate open).
    if (performance.getEntriesByName("card:tap").length) {
      performance.measure("card:ingress", "card:tap");
      performance.clearMarks("card:tap");
    }
    detailEl.classList.add("open");          // display:block; the timeline goes live
    detailScroll.scrollTop = 0;
    detailEl.scrollTop = 0;                  // closed, then rise
    detailEl.scrollTo({ top: cardMax() });   // the rise — CSS decides smooth vs instant
  }

  /**
   * ⭐ EGRESS — the close is OURS once it is committed (JJ, 2026-09-25).
   *
   * The problem: the browser's snap-to-closed is slow and untunable, and for its whole
   * duration #detail is still the topmost scroller — so the swipe you make NEXT, meaning to
   * move through the site, lands on the overlay and re-opens the card. Two fixes in one:
   *   1. the instant a close is committed, #detail goes `pointer-events: none` (.closing), so
   *      nothing can re-open it, and
   *   2. the remaining travel is an EXPONENTIAL APPROACH from wherever the overlay is: each
   *      frame moves (1 - e^(-dt/τ)) of the distance that remains, τ = --card-egress-tau.
   * 🐞 WHY NOT A TWEEN (JJ, 2026-09-25: "aggressively jerky"). A fixed-duration curve on the
   * shared ease STARTS SLOW, while the overlay is already moving at gesture speed; the coast
   * led for a few frames, the tween overtook, and the handover read as stall-then-jump. The
   * approach has no start: its speed is (remaining / τ), continuous with whatever came before,
   * and it re-bases from the CURRENT position every frame — so the coast, which is still
   * latched to the scroller and writes deltas between our frames in the same direction,
   * only ever hands us a smaller remainder. Never written backwards. Snap is off for the
   * duration so the UA's own settle cannot restart underneath.
   * ⛔ `behavior: "instant"` on every write — #detail has `scroll-behavior: smooth`, and a bare
   * `scrollTop =` would ANIMATE toward each frame's value.
   *
   * WHEN it is committed:
   *   · programmatic (sliver, Escape, popstate) — immediately.
   *   · wheel — the first `scroll` event past --touch-commit of the travel, once the card has
   *     settled open. Below that the browser still decides (a few-px chain that dies snaps
   *     back natively; slow, rare, and the honest answer for "you didn't mean it").
   *   · touch — same test, but at touchend: a finger on the glass owns the scroller and a
   *     tween under it would fight the drag. Released short of the threshold → snap back open.
   * This is J (position-at-release), which native gave us for free, with its resolution sped
   * up. The open stays native smooth.
   */
  let cardSettled = false;     // has the overlay reached its open stop since opening?
  let cardFinger = false;      // a touch is down while the card is open
  let egressTween = null;

  function finaliseClose() {
    const cause = closeCause; closeCause = null;
    egressTween = null;
    T.push({ k: "@closeDetail", cause: cause ?? "gesture" });
    if (cause !== "history") closeViaHistory();   // a gesture or UI close must unwind the URL
    detailOpen = false;
    cardSettled = false;
    detailEl.classList.remove("open", "closing");   // inert again; the timeline goes inactive
    detailEl.style.scrollSnapType = "";
    detailContent.innerHTML = "";
  }

  function egress() {
    if (!detailOpen || egressTween) return;
    detailEl.classList.add("closing");               // nothing can re-open it from here
    detailEl.style.scrollSnapType = "none";          // the UA settle must not restart underneath
    let last = performance.now();
    const step = (now) => {
      if (!egressTween) return;                      // cancelled by a finalise elsewhere
      const dt = Math.min(now - last, 50); last = now;   // a stalled tab must not teleport
      const cur = detailEl.scrollTop;
      const next = cur * Math.exp(-dt / CARD_EGRESS_TAU);
      if (next < 1) { detailEl.scrollTo({ top: 0, behavior: "instant" }); finaliseClose(); return; }
      if (next < cur) detailEl.scrollTo({ top: next, behavior: "instant" });
      egressTween.raf = requestAnimationFrame(step);
    };
    egressTween = { raf: requestAnimationFrame(step) };
  }

  /** Programmatic close. `cause` says whether the URL still needs unwinding. */
  function closeDetail(cause = "ui") {
    if (!detailOpen) return;
    closeCause = cause;
    egress();
  }

  /** A gesture has moved the overlay off its open stop. Past the threshold → ours. */
  const cardCommitted = () => {
    const max = cardMax();
    return max > 0 && detailEl.scrollTop < max * (1 - TOUCH_COMMIT);
  };
  detailEl.addEventListener("scroll", () => {
    if (!detailOpen || egressTween) return;
    if (detailEl.scrollTop >= cardMax() - 1) { cardSettled = true; return; }   // arrived / re-arrived
    if (!cardSettled || cardFinger) return;          // still rising, or a finger owns it
    if (cardCommitted()) egress();
  }, { passive: true });

  /** touch: defer the decision to the release. Registered on window because #detail may be
   *  display:none at touchstart; cheap, passive, and a no-op unless the card is open. */
  window.addEventListener("touchstart", () => { if (detailOpen) cardFinger = true; }, { passive: true });
  const cardTouchEnd = () => {
    if (!cardFinger) return;
    cardFinger = false;
    if (!detailOpen || egressTween || !cardSettled) return;
    if (cardCommitted()) egress();
    else if (detailEl.scrollTop < cardMax() - 1) detailEl.scrollTo({ top: cardMax() });   // short → back open
  };
  window.addEventListener("touchend", cardTouchEnd, { passive: true });
  window.addEventListener("touchcancel", cardTouchEnd, { passive: true });

  /** The native path still exists below the threshold: a small chain that the UA snaps all
   *  the way to 0 rests here. Also fires after an open and after every non-closing chain —
   *  hence the position test (tolerance: scrollTop can be fractional under zoom). */
  function onCardRest() {
    if (!detailOpen || egressTween) return;
    if (detailEl.scrollTop > 1) return;
    finaliseClose();
  }
  if ("onscrollend" in window) {
    detailEl.addEventListener("scrollend", onCardRest, { passive: true });
  } else {
    // settle-on-rest, the same 120ms idiom the tab track uses (see `settleTimer` above)
    let cardRestTimer = 0;
    detailEl.addEventListener("scroll", () => {
      clearTimeout(cardRestTimer);
      cardRestTimer = setTimeout(onCardRest, 120);
    }, { passive: true });
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
      coastRun: cssNum("--coast-run", 10),
      commitDist: cssNum("--commit-dist", 120),
      commitVel: cssNum("--commit-vel", 1.2),
      commitDistBack: cssNum("--commit-dist-back", 200),
      commitVelBack: cssNum("--commit-vel-back", 1.8),
      debug: cssNum("--gesture-debug", 0) === 1,
    },
    {
      detailOpen: () => detailOpen,
      tabTopY: () => tabTopY(),
      // ⭐ A: the region boundary is the artwork band's lower edge, not the tab frame's top.
      deckBottomY: () => deckBottomY(),
      tweenActive: () => !!worldTween,
    }
  );
  let lastT = 0;

  window.addEventListener("wheel", (e) => {
    // ⭐ card-native: while the card is open EVERY wheel belongs to the #detail scroller
    // (it sits above the stage and is the innermost scroller under the pointer). Nothing
    // detail-born reaches the arbiter any more — so no claim, no spend, no post-close guard.
    if (detailOpen) return;
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
    // ⭐ deltaX, momentum and deltaMode are all load-bearing now:
    //   momentum  — WheelEvent.momentum where the engine has it (Chrome 151+). Absent on
    //               Safari and Firefox, which fall to the hole detector.
    //   deltaX    — feeds the resume detector's VECTOR magnitude, which is what makes a
    //               horizontal swipe able to re-claim the deck at all (defect C).
    //   deltaMode — ⭐ non-zero means LINES or PAGES, i.e. a click-detented mouse wheel,
    //               which does not coast. Without it the hole detector reads an ordinary
    //               wheel hesitation as "the finger came back" and re-arms the transition
    //               on every spin, and coasting() latches the native-scroll gate ON for
    //               the session. See gesture-arbiter.mjs § the deltaMode guard.
    //               ⚠︎ Firefox only — Safari reports PIXEL for a mouse AND a trackpad.
    // ⛔ Dropping any of the three silently selects the trackpad-only path for every
    // device. The arbiter cannot tell a missing field from a genuine absence.
    arb.feed({ deltaY: e.deltaY, deltaX: e.deltaX, dt, clientY: e.clientY,
               momentum: e.momentum, deltaMode: e.deltaMode });
    if (T.on) T.wheel(e, dt, tBefore, arb.state());


    // ---- REGION: at (or heading to) landing — the deck is NATIVE on x (2026-09-24) ----
    // ⛔ THE VERTICAL→HORIZONTAL DECK MAPPING IS GONE. Until now a wheel over the artwork band
    // was preventDefault'd and its deltaY written to `carousel.scrollLeft`, which is the whole
    // reason a non-passive listener sat on `window`, and the origin of the arbiter's DECK
    // question (ownsCarousel, gRegion, claimRise/claimFloor, deckIdle/DECK_RUN, FIX 1, FIX 2).
    // `native-snap-spike-brief.md § 1c`, step 1: horizontal over the deck is left to the
    // browser — `.carousel` is `overflow-x: auto` and needs no help; shift+wheel and the mouse
    // click-drag below cover a wheel with no horizontal axis. Vertical over the deck goes to
    // landingVertical() at once: wheel-down enters the tab view without waiting for the deck
    // to exhaust. ownsCarousel() is never asked; the arbiter module itself is untouched.
    if (view === "landing") {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Over the deck: no preventDefault — the native scroller takes it. Over the tab frame:
        // swallow it, because `.track` must not move at landing (the panels are faded out and a
        // silent tab swap would surprise the next reveal). The horizontal-over-frame deck
        // browse that used to live here is deleted with the mapping.
        if (e.clientY >= deckBottomY()) e.preventDefault();
        arb.resetIntent();
        return;
      }
      e.preventDefault();
      landingVertical(e, dt);          // down → give then commit; up → the dead-end bounce
      return;
    }

    // ---- REGION: over the tab frame, in tab view ----
    // (the post-close "detail-born coast" guard that stood here is gone with card-native:
    //  a gesture latched to the card scroller has nowhere to go once the card is hidden)

    // horizontal is left entirely to the native snap track (no preventDefault); a
    // swipe mid-slide releases the nav tween so the gesture takes over
    // ⚠︎ giveWorld.release() here is `interaction-changes.md`'s row verbatim: "horizontal swipe
    // DURING a vertical give → give springs back, track takes over."
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      releaseTab(); arb.resetIntent(); giveWorld.release(); return;
    }
    const sub = subs[current];
    if (sub.scrollTop <= 0 && e.deltaY < 0) {          // at 0%, pulling up → landing
      // ⚠︎ CONDITIONAL, and that is the whole point — see EDGE-STRICT. Declining to prevent
      // is what lets `.sub`'s own contain-bounce play for a gesture that has already been
      // spent scrolling, instead of a hard stop.
      const live = tabLive();
      if (holdEdge(live)) e.preventDefault();
      arb.addIntent(-e.deltaY);
      // ⚠︎ `live` gates the give too, not just the commit. A spent gesture — a coast still
      // arriving after a transition already fired — must not drive the elastic either, or
      // the view breathes on its own after every commit.
      if (live && arb.meant(arb.intent, -e.deltaY, dt, true)) goLanding();
      else if (live) giveWorld.drive(arb.intent);
    } else {
      arb.resetIntent(); giveWorld.release();
      // ⭐ THE ONE LINE THE TAB WAS MISSING. The flick that scrolled the panel has had its
      // action; reaching the top is not a second one. Mirrors the card exactly.
      if (EDGE_STRICT) arb.spendOnNativeScroll();
    }
  }, { passive: false });

  // ---- touch: axis-lock at gesture start ----
  // No hover on touch, so the first few pixels decide the axis for the whole
  // gesture: horizontal browses (native), vertical commits.
  let tsX = 0, tsY = 0, tAxis = null, tDone = false;
  const AXIS_LOCK = 8;              // px before the axis is decided

  /**
   * ── D2: EVERY VERTICAL BOUNDARY IS 1:1 ON TOUCH (2026-08-18, JJ) ──────────────────
   *
   * ⭐ THE MODEL, SETTLED: "one vertical drag owns the whole axis. Through the middle it is
   * 1:1 — the finger is holding the landing. At the ends it gets heavy and stops."
   *
   * ⚠︎ SO THIS IS NOT "GIVE ON TOUCH", AND D2 IS NOT A RIDE-ALONG ON D. On wheel there is no
   * middle — you are always AT a boundary — so the 100px elastic is all you ever see. On
   * touch that same boundary is a LANDING_H traverse, and give is REPLACED by it, not
   * extended. Give survives on touch only at true dead-ends.
   *
   * ⚠︎ Region-blindness was already here: this handler has never had a region test for
   * vertical. What was missing is CONTINUITY — the landing sat still until --commit-dist and
   * then jumped. That threshold is gone from this branch; see touchend.
   *
   * ⭐ AND IT STAYS `passive: true`. Driving the world from touchmove normally forces
   * `preventDefault`, hence a non-passive listener, hence every touchmove blocking the
   * compositor until JS returns — the difference between native-smooth and janky. It does
   * not apply here: `html, body { overflow: hidden }`, `#stage` is fixed, and `.sub` is
   * `overflow-y: hidden` AT LANDING, so a vertical swipe scrolls nothing and there is
   * nothing to prevent. ⛔ tab → landing and card → site do NOT get this for free — both
   * fight a live native scroller. Do not assume this generalises when extending D2.
   */
  /**
   * null   = not decided yet this gesture
   * "none" = decided: the native scroller owns it, stay out of the way for the whole gesture
   * "world" | "card" = we are driving that scalar
   * ⚠︎ Three states, not a boolean, because "we already looked and the answer was no" has to
   * be distinguishable from "we have not looked yet" — otherwise the decision gets re-made
   * every event, which is the per-event-signal-as-state bug this file has now hit three times.
   */
  let tDrive = null;
  let tBase = 0, tLockDy = 0;       // the scalar when the axis locked, and the dy already spent
  let tvY = 0, tPrevY = 0, tPrevT = 0;   // release velocity, px/ms, smoothed
  let tRaf = 0, tPending = 0;            // see flushTouch

  /**
   * ⭐ ONE WRITE PER FRAME, NOT ONE PER EVENT.
   *
   * Phones report touches at 120Hz+ while they paint at 60, so up to half of every
   * transform / opacity / colour write was being thrown away — and it happened INSIDE a
   * `{ passive: false }` handler, so the wasted work landed directly on input latency before
   * the compositor was released.
   *
   * touchmove now only records the target; this applies it. `applyWorld` / `applyStage` stay
   * the single writers — this defers them, it does not add a second one.
   * ⚠︎ Costs up to one frame of latency. That is the standard trade for coalescing, and it is
   * strictly better than spending that frame on writes nobody sees.
   */
  const flushTouch = () => {
    tRaf = 0;
    if (tDrive === "world") {
      // ⚠︎ Above the landing there is nothing, so reuse the wheel's dead-end curve rather than
      // hard-stopping — otherwise touch and wheel disagree at the same edge.
      applyWorld(tPending > 0 ? bounceOf(tPending) : Math.max(-LANDING_H, tPending));
    }
  };

  window.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    tsX = t.clientX; tsY = t.clientY; tAxis = null; tDone = false;
    // ⚠︎ Only on a genuinely NEW touch. A second finger landing mid-drag also fires
    // touchstart, and clearing tDrive there would strand the scalar part-way with no release
    // left to spring it back.
    if (e.touches.length === 1) tDrive = null;
    // touchstart IS a gesture boundary — and it is also where this gesture stakes its claim,
    // from the finger's own landing point. Same rule as wheel, better signal.
    arb.beginGesture(t.clientY);
  }, { passive: true });

  /**
   * ⚠︎ `{ passive: false }` — REQUIRED, and it has a cost. Driving a scalar from touchmove at a
   * boundary means preventing the scroller underneath, and a non-passive listener puts JS on
   * the compositor's critical path for every touchmove. D2a got away with `passive: true`
   * because nothing scrolls vertically at the landing; D2b/D2c do not, because `.sub` and
   * `#detailScroll` are live scrollers.
   * ⛔ SO KEEP THIS BODY SMALL. No measurement, no layout reads per event — the one
   * `scrollTop` read happens ONCE, at axis lock, below.
   */
  window.addEventListener("touchmove", (e) => {
    if (tDone || detailOpen) return;         // card-native: the card is the browser's
    const t = e.touches[0];
    const dx = t.clientX - tsX, dy = t.clientY - tsY;
    if (!tAxis) {
      if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
      tAxis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (tAxis === "x") { releaseTab(); return; }   // horizontal → native carousel / track

    /**
     * ⭐ THE DECISION IS MADE ONCE, AT AXIS LOCK, AND NEVER RE-EXAMINED.
     *
     * ⛔ This is deliberate and it is the lesson of three separate bugs today (`consumed` at
     * the deck's edge, `release()` in a flipping branch, `regRun`): A SIGNAL THAT IS CORRECT
     * PER EVENT IS NOT CORRECT AS A STATE. `scrollTop <= 0` is exactly such a signal — testing
     * it every event would hand the drive over the instant a mid-panel drag happened to reach
     * the top, which is scroll-chaining, and would flicker at the boundary.
     *
     * ⭐ Deciding once also states edge-strict on touch: a drag that began mid-panel has the
     * panel's action, and reaching the top is not a second one. Same rule as wheel.
     * ⚠︎ And it is the performance fix — one `scrollTop` read per GESTURE, not per event.
     */
    if (tDrive === null) {
      tDrive = "none";
      const down = dy > 0;
      if (view === "landing") {
        tDrive = "world"; tBase = worldY;            // the traverse — either direction
      } else if (down && subs[current].scrollTop <= 0) {
        tDrive = "world"; tBase = worldY;            // tab → landing, from the panel's top
      }
      if (tDrive !== "none") {
        // ⚠︎ DIRECT MANIPULATION OUTRANKS A LERP. Catching a transition mid-flight is this
        // project's defining property; on touch it is literal. Base off the LIVE scalar.
        if (tDrive === "world" && worldTween) { worldTween.cancel(); worldTween = null; }
        // ⭐ ONE layout read for the whole gesture — see paintNav. The horizontal axis is
        // locked out from here, so these two cannot change until the finger lifts.
        const w = tabW();
        navCache = { w, pos: w ? track.scrollLeft / w : 0 };
        tLockDy = dy; tvY = 0; tPrevY = t.clientY; tPrevT = performance.now();
      }
    }
    if (tDrive === "none") return;                   // the panel scrolls natively; leave it alone

    e.preventDefault();
    const now = performance.now(), ms = now - tPrevT;
    if (ms > 0) tvY = tvY * 0.6 + ((t.clientY - tPrevY) / ms) * 0.4;   // EMA, px/ms
    tPrevY = t.clientY; tPrevT = now;
    // ⭐ LANDING AND TAB ARE THE SAME DRIVE. Both are worldY over the same span; only the
    // starting point differs, and the clamp decides which way there is room. D2a and D2b are
    // one mechanism, which is why they share a commit rule below.
    // ⚠︎ RECORD ONLY — the write happens once per frame in flushTouch. Keeping style writes out
    // of this handler is the point: it returns sooner, so the compositor is released sooner.
    tPending = tBase + (dy - tLockDy);
    if (!tRaf) tRaf = requestAnimationFrame(flushTouch);
  }, { passive: false });

  /**
   * ⭐ J, ARRIVING FREE — at all three boundaries now. `touchend` is a REAL release, so commit
   * is the natural touch idiom: past a fraction of the traverse, or flicked hard.
   * ⭐ Halfway is SYMMETRIC BY CONSTRUCTION, so touch answers `§ G`'s forward-vs-back
   * asymmetry question inside its own domain without touching either --commit-dist token.
   * ⚠︎ A hard flick the OTHER WAY cancels even past halfway — position alone would strand a
   * user who dragged far, changed their mind and threw it back, which is the teleport
   * complaint wearing a different hat.
   */
  const endTouchDrag = () => {
    // ⛔ FLUSH FIRST, and while tDrive is still set. The commit reads worldY/stageY, and a
    // pending frame would leave them one event stale — enough to land the wrong side of
    // --touch-commit on a fast release.
    if (tRaf) { cancelAnimationFrame(tRaf); flushTouch(); }
    const drive = tDrive;
    tDrive = null;
    navCache = null;        // ⛔ before any commit — the tweens below must read live values
    if (drive !== "world") return;
    /* ⚠︎ TOUCH HAS ITS OWN VELOCITY THRESHOLD, and borrowing --commit-vel was the bug.
       1.2px/ms is 1200px/s — a number tuned for a WHEEL accumulator. A comfortable phone swipe
       covers 150-400px in 150-300ms, i.e. 0.5-2.5px/ms, so a large share of deliberate swipes
       failed the flick test and fell back to needing --touch-commit of the WHOLE traverse.
       On a phone that is half the screen, which is why JJ's report was "way too strict". */
    const V = TOUCH_VEL;
    {
      const p = LANDING_H ? -worldY / LANDING_H : 0;
      const up = -tvY;                        // px/ms, positive = swiping up = toward the tab
      const toTab = up >= V ? true : up <= -V ? false : p >= TOUCH_COMMIT;
      // ⚠︎ goTab/goLanding early-return when already in that view, which would leave worldY
      // displaced with nothing to put it back. Spring explicitly in that case.
      if (toTab) { if (view === "tab") worldTo(-LANDING_H); else goTab(); }
      else       { if (view === "landing") worldTo(0); else goLanding(); }
    }
  };
  window.addEventListener("touchend", endTouchDrag, { passive: true });
  window.addEventListener("touchcancel", endTouchDrag, { passive: true });

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
    measureContact();   // ⚠︎ re-measure HERE, never in the click path — see measureContact
    if (cxOpen) navTrack.style.transform = `translateX(${-cxShift()}px)`;
  }

  // How far the track travels. The extras are parked --contact-gap past the track's
  // right edge, so sliding by (their width + that gap) lands their RIGHT edge exactly
  // on the track's right edge — i.e. the same 60 line the rest of the frame uses.
  // The gap term MUST match the CSS `left` offset; both read --contact-gap so they
  // cannot drift. ⚠︎ NO LONGER measured live on every open — see measureContact() below
  // for why that moved and what it was costing. A translate does not change
  // getBoundingClientRect().width, so measuring mid-lerp is still safe.
  const CX_GAP = parseFloat(getComputedStyle(root).getPropertyValue("--contact-gap")) || 60;

  /**
   * ⭐ THE EXTRAS' WIDTH IS MEASURED ON A SCHEDULE, NOT ON EVERY OPEN (2026-08-23, JJ).
   *
   * 🐞 THE BUG THIS IS AIMED AT: the contact dim is instant on OPEN and gradual on CLOSE,
   * on Safari only (`safari-fork-brief § 1`). ⛔ That brief's test 1 — `will-change:
   * transform` on `.nav-track` — HAS BEEN SHIPPED THE WHOLE TIME and the bug survives it,
   * so compositing promotion of the track is not the cause. The asymmetry was always
   * evidence against it: promotion would misbehave in both directions.
   *
   * ⭐ WHAT IS ACTUALLY ASYMMETRIC IS THIS CODE. setContact() used to run
   * `cxShift()` — a getBoundingClientRect(), i.e. a FORCED SYNCHRONOUS LAYOUT — on the
   * OPEN path and never on the close path, one statement before the class toggle that
   * drives the dim. A code-level asymmetry sitting exactly under a bug-level asymmetry is
   * a far better lead than an engine quirk that ought to be symmetric.
   *
   * ⚠︎ WORTH DOING EVEN IF IT DOES NOT FIX SAFARI. A forced layout in a click handler that
   * also writes style is layout thrash on a user interaction; the same reasoning already
   * keeps DECK_H out of the wheel handler. So this is a real improvement first and a
   * hypothesis test second — which is why it was made rather than only probed.
   *
   * ⚠︎ THE WIDTH ONLY CHANGES ON THINGS THAT ALREADY RE-MEASURE. Font swap and resize both
   * land in measureGeom(); init and fonts.ready both call pinContact(). Nothing else can
   * move it — the "Copied!" label is an absolutely-positioned overlay precisely so it
   * cannot change the extras' width, and a translate does not change a border-box width.
   *
   * ⚠︎ IF THE DIM STILL CUTS ON OPEN after this, our code is CLEARED and the next suspect
   * is `var()` inside the `transition` shorthand — expand the four to longhands. Do that
   * as its own change, not bundled here, or neither result means anything.
   */
  let CX_W = 0;
  function measureContact() {
    if (cxExtras) CX_W = cxExtras.getBoundingClientRect().width;
  }
  const cxShift = () => CX_W + CX_GAP;

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
  // DECK — mouse click-drag (2026-09-24). `native-snap-spike-brief.md § 1c`.
  //
  // The vertical→horizontal wheel mapping is gone (see the wheel handler), so a mouse with no
  // horizontal axis needs another way to browse the deck: shift+wheel (native) and this.
  // ⭐ MOUSE ONLY. `pointerType === "mouse"` — a touch drag is the browser's, and a trackpad
  // swipes sideways natively. Bounded by real start/end events, so it needs no arbitration.
  // ⛔ CAPTURE AFTER THE THRESHOLD, NOT ON pointerdown. setPointerCapture retargets the
  // resulting `click` to the captured element, which would break a plain click on a card.
  // ⛔ `clientX` deltas, not `movementX` (DPR-scaled on some Chrome platforms).
  // ⚠︎ The cards are real anchors: a drag past the threshold must swallow the click that fires
  // on release (capture-phase, before the [data-detail] listener below sees it), and
  // `dragstart` must be cancelled or the browser starts a native HTML drag of the artwork.
  // Dead stop on release — no inertia (JJ).
  // ============================================================================
  const DRAG_START = 5;             // px before a press becomes a drag
  let dragOn = false, dragMoved = false, dragId = -1, dragX = 0, dragLeft = 0, dragSwallow = false;
  if (carousel) {
    carousel.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      dragOn = true; dragMoved = false; dragSwallow = false;
      dragId = e.pointerId; dragX = e.clientX; dragLeft = carousel.scrollLeft;
    });
    carousel.addEventListener("pointermove", (e) => {
      if (!dragOn || e.pointerId !== dragId) return;
      const dx = e.clientX - dragX;
      if (!dragMoved) {
        if (Math.abs(dx) < DRAG_START) return;
        dragMoved = true;
        carousel.setPointerCapture(dragId);
        carousel.classList.add("dragging");
      }
      carousel.scrollLeft = dragLeft - dx;
    });
    const endDrag = (e) => {
      if (!dragOn || e.pointerId !== dragId) return;
      dragOn = false;
      if (!dragMoved) return;
      dragSwallow = true;                       // the click that follows is not a click
      carousel.classList.remove("dragging");
      if (carousel.hasPointerCapture(dragId)) carousel.releasePointerCapture(dragId);
    };
    carousel.addEventListener("pointerup", endDrag);
    carousel.addEventListener("pointercancel", endDrag);
    carousel.addEventListener("dragstart", (e) => e.preventDefault());
    carousel.addEventListener("click", (e) => {
      if (!dragSwallow) return;
      dragSwallow = false;
      e.preventDefault(); e.stopPropagation();
    }, true);
  }

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

  /* Tapping the sliver of landing/tab in the 120px gap → back to the previous state.
   *
   * 🐞 preventDefault() IS NOT OPTIONAL, AND stopPropagation() ALONE NEVER COVERED IT
   * (JJ, 2026-08-23: "clicking outside the card sometimes clicks into elements there").
   * stopPropagation() stops LISTENERS. It does nothing to a DEFAULT ACTION, and the
   * carousel and grid cards are real anchors — `<a class="card" href="/art/slug">`, kept
   * that way on purpose so cmd-click and "open in new tab" work normally. So a click on
   * the sliver over a card was cancelled as far as every listener could see, and then the
   * browser navigated anyway. A full page load, which is why it read as "sometimes": it
   * only happened where an anchor sat under the sliver.
   *
   * ⚠︎ This also cancels cmd/middle-click on those anchors WHILE A CARD IS OPEN, and that
   * is intended: the sliver is a close affordance, not a link surface. The same anchors
   * behave completely normally the moment the card is shut.
   *
   * ⛔ NOT SOLVED WITH pointer-events: none ON #world, which is the tidier-looking fix.
   * pointer-events changes HIT TESTING, and hit testing is what routes wheel and touch
   * events to a region — so it would reach straight into the most heavily tested subsystem
   * in the project to fix a click bug. Two lines here beat that. */
  /* card-native: the sliver IS #detailSpacer (the top 120px of it still showing at open), so
   * the close tap is a click on the spacer. The old capture-phase listener on #stage is gone:
   * #detail now sits ABOVE the stage, so no click over the sliver can reach an anchor
   * underneath — the preventDefault story above is moot by construction. */
  detailSpacer.addEventListener("click", () => closeDetail("ui"));

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
  /**
   * ⭐ WARM (2026-09-24) — `placeholder-fork-brief.md § PART 2`. The symptom: the first tap on a
   * work starts its reveal a beat late, every later tap is instant. The fetch is not the bug;
   * WHEN it is awaited is. WARM moves the request earlier and changes no animation code:
   *   · the featured deck's partials are prefetched on idle after load (low priority);
   *   · any [data-detail] press prefetches on `pointerdown`, ~100ms+ before its click.
   * ⚠︎ The cache now holds PROMISES, not strings, so a pointerdown prefetch and the click that
   * follows it share ONE request instead of racing two. A failed fetch evicts its entry so the
   * next attempt retries rather than replaying the failure.
   * 🅿️ MEASURE: `performance.getEntriesByName("card:ingress")` in the console — pointerdown →
   * reveal start, per open. The brief's bar is "consistently under one frame" before REORDER
   * is even considered.
   */
  const partialCache = new Map();   // path -> Promise<string>

  function loadPartial(path) {
    if (!partialCache.has(path)) {
      const p = fetch(`/${path}/content`, { headers: { Accept: "text/html" }, priority: "low" })
        .then((res) => {
          if (!res.ok) throw new Error(`partial ${path}: ${res.status}`);
          return res.text();
        })
        .catch((err) => { partialCache.delete(path); throw err; });
      partialCache.set(path, p);
    }
    return partialCache.get(path);
  }

  /** WARM, half 1: the deck's partials, on idle, in feature order. Errors are silent here —
   *  a prefetch that fails just leaves the click path exactly as it was. */
  function warmFeatured() {
    const paths = [...document.querySelectorAll("#carousel [data-detail]")]
      .map((a) => a.dataset.detail);
    (async () => { for (const path of paths) { try { await loadPartial(path); } catch {} } })();
  }
  const onIdle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));   // Safari lacks rIC
  onIdle(warmFeatured);

  /** WARM, half 2: the press. pointerdown fires for mouse AND touch, well before click. */
  document.addEventListener("pointerdown", (e) => {
    const hit = e.target.closest?.("[data-detail]");
    if (!hit) return;
    performance.mark("card:tap");
    loadPartial(hit.dataset.detail).catch(() => {});
  }, { passive: true });

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
    syncTechTail();
    detailEl.scrollTo({ top: cardMax(), behavior: "instant" });   // presented AT REST, no rise
    cardSettled = true;
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
    else if (!wantsDetail && detailOpen) closeDetail("history");   // the URL already moved
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
  // ============================================================================
  // RETUNE — dev only. Re-read every [TUNE] token after a CSS hot-swap.
  // ============================================================================
  /**
   * ⭐ THE TRAP THIS CLOSES, recorded in `hooks.md § Motion audit`: JS reads every [TUNE]
   * token ONCE at init, and Astro's HMR hot-swaps global.css WITHOUT re-running the module.
   * So editing --give-max, --site-zoom-max or any arbiter token in dev APPEARS TO DO
   * NOTHING until a hard reload. This did not exist with `open prototype-v6.html`, and it
   * is worst exactly where tuning matters most — you cannot tell "that value did nothing"
   * from "the reload didn't take."
   *
   * ⚠︎ DEV ONLY, and it must stay that way. `import.meta.hot` is undefined in a production
   * build, so the whole block is dead code there. Nothing on the hot path reads it.
   *
   * ⚠︎ The arbiter's config is MUTATED IN PLACE rather than re-creating the arbiter. That is
   * deliberate: a fresh arbiter would lose gestureId, the claim and the coast histories
   * mid-gesture, so retuning would silently reset segmentation and you would be tuning
   * against a different machine than the one you are feeling.
   *
   *   window.__retune()      by hand, from the console
   *   (automatic on every Vite CSS update)
   */
  function retune() {
    ease = easeFromToken();
    DUR        = cssMs("--dur", 500);
    SITE_ZOOM  = cssNum("--site-zoom-max", 1.1);
    SITE_BLUR  = cssNum("--site-blur-max", 50);
    CARD_ZOOM  = cssNum("--card-zoom-min", 0.95);
    FADE_FLOOR = cssNum("--fade-floor", 0.2);
    BLUR_FLOOR = cssNum("--blur-floor", 0.4);
    CARD_BLUR    = cssNum("--card-blur", 1);
    CARD_BLUR_IN = cssNum("--card-blur-in", 0.45);
    VEIL_MODE    = cssNum("--card-veil-mode", 1);
    VEIL_OP      = cssNum("--card-veil-op", 0.9);
    if (cardBlur) {
      cardBlur.classList.toggle("off", !CARD_BLUR);
      cardBlur.classList.toggle("solid", !VEIL_MODE);
      if (!CARD_BLUR) cardBlur.style.opacity = "0";
    }
    GIVE_MAX   = cssNum("--give-max", 0.5);
    GIVE_EASE  = cssNum("--give-ease", 2);
    TOUCH_COMMIT = cssNum("--touch-commit", 0.3);
    TOUCH_VEL    = cssNum("--touch-vel", 0.5);
    EDGE_STRICT  = cssNum("--edge-strict", 1) === 1;
    BOUNCE_MAX   = cssNum("--bounce-max", 48);
    BOUNCE_DIST  = cssNum("--bounce-dist", 300);
    LANDING_GIVE = cssNum("--landing-give", 1) === 1;
    CARD_EGRESS_TAU = cssMs("--card-egress-tau", 70);
    Object.assign(arb.config, {
      gestureGap: cssMs("--gesture-gap", 100),
      reverseFrac: cssNum("--gesture-reverse", 0.25),
      repushRun: cssNum("--repush-run", 3),
      repushFloor: cssNum("--repush-floor", 0.2),
      repushArm: cssNum("--repush-arm", 0.25),
      claimRise: cssNum("--claim-rise", 1.5),
      claimFloor: cssNum("--claim-floor", 0.2),
      coastRun: cssNum("--coast-run", 10),
      commitDist: cssNum("--commit-dist", 120),
      commitVel: cssNum("--commit-vel", 1.2),
      commitDistBack: cssNum("--commit-dist-back", 200),
      commitVelBack: cssNum("--commit-vel-back", 1.8),
      debug: cssNum("--gesture-debug", 0) === 1,
    });
    // ⚠︎ REPAINT AT THE CURRENT POSITION. Every dynamic is position-derived, so a token that
    // changes the MAPPING (zoom, fade floor) shows nothing until something re-applies it.
    // Without these two lines retune() would look broken for exactly the tokens you most
    // want to feel.
    navLast.fill(-1);                   // force a repaint; the mapping may have changed
    measureGeom();
    applyWorld(worldY);
  }

  if (import.meta.hot) {
    window.__retune = retune;
    import.meta.hot.on("vite:afterUpdate", retune);
  }

  let lastW = window.innerWidth, lastH = window.innerHeight;

  window.addEventListener("resize", () => {
    const w = window.innerWidth, h = window.innerHeight;
    const heightOnly = w === lastW && h !== lastH;
    lastW = w; lastH = h;

    if (heightOnly && worldTween) {
      measureGeom();
      // RE-AIM, don't cancel. Contact is left alone: its geometry is the nav's line width,
      // which is width-driven, so a height-only change has not invalidated it.
      if (worldTween) worldTo(view === "tab" ? -LANDING_H : 0);
      return;                                     // snap offset is width-driven: nothing to do
    }

    // a genuine resize invalidates every in-flight target — land on the current state instead
    if (worldTween) { worldTween.cancel(); worldTween = null; }
    setContact(false);                            // an open group is stale geometry
    measureGeom();
    applyWorld(view === "tab" ? -LANDING_H : 0);
    if (detailOpen) detailEl.scrollTo({ top: cardMax(), behavior: "instant" });   // re-seat the open stop
    scrollToTab(order.indexOf(current), false);   // px snap offset changes with width
  });
}
