# astro-port — P1: scaffold + content collections

Branch `astro-port`. **P1 only:** the app builds, reads real CMS content, and answers
"does the data map cleanly?" It is **not** the design — that lands at P3/P4 when the v6
shell and the detail routes are ported. `src/pages/index.astro` is a data-proof page and
gets deleted then.

```
npm install
npm run build                                   # static -> dist/
npm run dev                                     # local
npm run data:report                             # what's in the CMS right now + flags
node scripts/diff-v6.mjs <path>/prototype-v6.html   # CMS vs the v6 snapshot
```

## What's here

| file | role |
|---|---|
| `astro.config.mjs` | static output, no adapter. Target is **Workers Static Assets**, not classic Pages. |
| `src/content.config.ts` | typed collections against `.pages.yml` @ `2cd3e2d`. |
| `src/lib/map.ts` | **the naming bridge** — the only place CMS names become prototype names. |
| `scripts/content-report.mjs` | field population + data-quality flags. Replaces hand-auditing. |
| `scripts/diff-v6.mjs` | one-time migration check against v6's inline arrays. |

## Three decisions worth knowing before you edit

**Nothing visual is required.** Every visual field is empty in all 26 content files, so a
strict schema would fail the build on 100% of real content. Empty is the normal case and
components must render an empty state.

**Legacy fields are tolerated, not blessed.** Seven news files still carry a flat `image:`
and four carry `gallery` as flat strings, all pointing at `/assets/…` — an origin deleted
on 2026-08-10. Rejecting them fails the build on real content; accepting them silently
hides the migration. So they parse, and `data:report` counts them every time you run it.

**`eventType` stays a strict enum.** A sixth value should fail the build rather than render
as a raw string — that is exactly how the off-schema `Screening` value reached the site
before. All five values in use are valid today.

## What P1 found

**v6's copy has DRIFTED, not just aged.** Roughly 20 fields differ, and most are edits
rather than additions — exhibitions lines now carry the show name (`Self—ish, Helix Art
Space (Stockholm), 2026` vs `Helix Art Space (Stockholm), 2026`), `personhood`'s
acknowledgements were rewritten, four artwork taglines changed, and four news items were
retitled. Re-syncing the prototype by hand a third time would have shipped stale copy again.

**One genuinely new news item** (`ai-as-an-art-material`), and one new artwork (`BEAM`).
The other four "new" news items in a naive comparison are retitles — which is why
`diff-v6.mjs` matches on **date**, not title.

**30 values the CMS has and the site has never shown** — `medium` / `size` / `duration`,
now 11/11. These become the grey spec line under the artwork title (P5).

## Known gaps, carried forward

- ✅ **`personhood`'s date is RESOLVED** (JJ, 2026-08-13): it should not show a range.
  The CMS has always said `2024-10-01` and that is correct; v6's "2024 - 2026" was
  prototype drift. The port renders "2024". No schema change needed, flag removed.
- The gesture arbiter (P0) lives in the **design workspace**, not here, because its
  differential test reads `prototype-v6.html`. It moves into `src/lib/` at P3 — **one copy,
  not two**; duplicating it is the drift risk P0 exists to prevent.
- `_posts/2026-08-04-hello.md` is scaffolding junk from whatever created the repo.

---

# P3 — the shell, ported

The v6 landing is now an Astro app rendering real CMS content. `npm run dev` and it runs.

| | |
|---|---|
| `src/styles/global.css` | v6's entire style layer, **extracted not retyped**. All 35 `[TUNE]` tokens keep their names. Port additions are below a marked line at the end. |
| `src/layouts/Site.astro` | the shell — `#detail` / `#stage` / `#world`. The nesting is load-bearing. |
| `src/components/` | Carousel · Nav · ArtGrid · NewsList · Bio · **Media** |
| `src/scripts/site.js` | the motion layer. Geometry, tweens, transitions, wheel/touch, contact, detail. |
| `src/lib/gesture-arbiter.mjs` | P0's module. **One copy.** Do not duplicate it back into a prototype. |

## What changed from v6, and nothing else did

**The panels are pre-rendered.** ~290 lines of v6 that built the carousel, grid, news list
and bio in the browser are gone; Astro renders them from content collections. The click
wiring is now one delegated listener instead of per-card handlers.

**`--ease` is read.** v6 declared it `[TUNE]`, documented it, and hardcoded
`cubic-bezier(0.5,0,0,1)` in every tween — the 2026-08-09 health check called it "a lie"
and the one cleanup worth doing unprompted. `tween()` parses the token now, with the old
literal as fallback.

**`TECH` is deleted.** `technicalTagline` / `technicalText` are 11/11 in the CMS, so the
technical section reads real fields. (The *text* is still lorem — content, not code.)

**News `statement` renders.** 13/15 populated, and v6 fell back to `subheading` (2/15).
`v4-cms-audit.md` called this the largest content-to-site gap; it is closed.

**The spec line exists.** `medium` / `size` / `duration` as grey text under the artwork
title, per JJ 2026-08-13. New `--spec-gap` token. Expect one round of review on the treatment.

## ⚠︎ The bug this port already caught

v6 wrote the arbiter's internals **from three places outside the wheel path** —
`openDetail()` claimed `gRegion` directly, the horizontal deck-browse read it, and
`touchstart` minted a gesture by hand (`gestureId++; spentOn = -1; gRegion = …`).

P0's extraction missed all three, **and the differential test passed anyway, because it
only exercised wheel events.** The ported page threw `gRegion is not defined` on first load.

Fixed by surfacing them as named operations — `claimRegion()`, `region()`,
`beginGesture()` — with six tests each pinning behaviour, including that `beginGesture`
deliberately does **not** reset `peak`/`prevDir` the way `newGesture()` does. The
differential streams now interleave touch begins and region claims too. **54 tests green.**

## The empty media state is the default case

Every visual field is empty in all 26 content files, so `.media-empty` is what the site
renders today — 24 placeholders on the landing alone. It carries an explicit aspect ratio
because v6's images sized their own boxes from intrinsic dimensions; an empty `<div>`
collapsed the carousel to **zero scroll width**. Real images take over as they land.

## Verified in a real browser

Built output, Chromium, 1440×900:

- 5 featured / 11 grid / 15 news / 3 bio sections / 24 bio rows — all correct
- landing → tab → card rises → close, full chain, **no console errors**
- `--detail-bleed` resolves as a **formula**, not a magic number
- ⭐ `#bio` padding-top `0px`, `.about` padding-top `134px`, and bio columns land at
  **identical** offsets — v6's one-bug fix carried, not silently reintroduced

## Still to do (P4)

The detail card is built from an embedded JSON payload — marked `P4 SEAM` in
`index.astro` and `site.js`. P4 replaces it with `/[type]/[slug]` routes pre-rendering the
card open, `_content` partials fetched on click, and the `buildSheet`-adopts-pre-rendered-DOM
hinge that makes the no-JS and SEO paths work.

---

# P4 — detail routes, partials, and the adopt hinge

The locked architecture from `hooks.md § Detail-route architecture`, implemented. **53 pages
build**: the landing, 11 artworks, 15 news items, and a bare partial for each.

```
/                          the landing
/art/<slug>                the landing with the sheet PRE-RENDERED OPEN
/art/<slug>/content        the bare sheet content (partial: true)
/news/<slug>               ditto
/news/<slug>/content
```

## One renderer, not two

`Work.astro` and `NewsItem.astro` are each rendered by **both** their route and their
partial. That is what makes hooks' requirement — *"the fetched markup is identical to what
the route inlines"* — true by construction rather than by discipline. **Verified: the
partial and the inlined markup are byte-identical** (2,336 bytes each for `2025pcm`).

v6's JavaScript detail-markup generator is **deleted**, and so is P3's intermediate
embedded-JSON payload. There is now exactly one description of what a work's sheet looks like.

## The hinge

`buildSheet` had to learn to *adopt* as well as build:

| arriving by | what happens |
|---|---|
| **in-site click** | fetch `/type/slug/content`, inject, run the rise, `pushState` |
| **cold URL load** | the route already inlined it — `adoptSheet()` presents it **at rest, no rise** |
| **no JavaScript** | the `<a href>` loads the route; the sheet is already up |
| **back button** | `popstate` closes it; a gesture-close calls `history.back()` itself |

A rise is the response to a click, and arriving by URL is not a click — so the cold path
measures and presents rather than animating. Cards are now real `<a href>` elements, and the
click handler only intercepts a plain left-click, so cmd-click and "open in new tab" work.

## ⚠︎ `_content` had to become `content`

`hooks.md` specifies `_content.astro`. **Astro excludes any file or directory under
`src/pages` whose name begins with `_` from routing entirely** — so with the underscore, the
build succeeds, the route silently does not exist, the fetch 404s, and every click falls
back to a full page load. Cosmetic rename; same architecture. Worth correcting in hooks.

## Verified in a browser — 18 checks, 0 failures

Cold load: sheet renders (2,341 bytes), presents at rest (**one** distinct stage transform
across 8 frames — it does not animate), clears `.cold`, seeds history state.
Click: exactly one partial fetch, no full-page navigation, URL pushed, rise runs.
Back: URL returns to `/` and the sheet closes.
No-JS: card is a real link, navigates, content is in the HTML, sheet marked open.
Gesture close: rewinds the URL to `/`, and re-opening afterwards still works.

## Still open

- **`/art`, `/news`, `/bio` panel routes.** hooks says the nesting extends naturally
  (`/news` = News panel open). Not built — the three panels are reachable but have no URLs.
- ~~`personhood`'s date~~ — **resolved** (JJ, 2026-08-13): no range intended, the CMS is
  correct, v6 had drifted. The port already renders "2024".
- **Every image is still a placeholder.** Nothing here is blocked on that.
