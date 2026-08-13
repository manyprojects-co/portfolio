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

- ⚠︎ **`personhood` cannot express its own date.** `productionDate` is a month-precision
  `date`; v6 shows "2024 - 2026". Needs Xin, or a schema change.
- The gesture arbiter (P0) lives in the **design workspace**, not here, because its
  differential test reads `prototype-v6.html`. It moves into `src/lib/` at P3 — **one copy,
  not two**; duplicating it is the drift risk P0 exists to prevent.
- `_posts/2026-08-04-hello.md` is scaffolding junk from whatever created the repo.
