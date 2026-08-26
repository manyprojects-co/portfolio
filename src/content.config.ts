import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/**
 * content.config.ts — typed against the REAL `.pages.yml` at commit 2cd3e2d (2026-08-13).
 *
 * ⚠︎ READ THIS BEFORE EDITING. The schema was rewritten twice in the week of Aug 4–13 and
 * `v4-cms-audit.md` is two generations behind it. What changed most recently (087aee8,
 * "Deleting all media", 2026-08-10):
 *   · all 76 images were deleted from `public/assets` — the repo now holds ZERO image files
 *   · the `media:` block was removed from `.pages.yml`, so Pages CMS has no media picker at
 *     all and every visual is a hand-pasted URL string
 *   · every visual became an `{ mediaType, imageUrl, videoUrl }` object
 *
 * Consequences encoded below:
 *   1. NOTHING VISUAL IS REQUIRED. Every visual field is empty in every file today, so a
 *      strict schema would fail the build on 100% of real content. Empty is the normal case.
 *   2. LEGACY FIELDS ARE TOLERATED, NOT BLESSED. Four news files still carry `gallery` as a
 *      flat string list and seven carry a flat `image:` — both pointing at the deleted
 *      `/assets/…` paths. Rejecting them fails the build on real content; silently accepting
 *      them hides the migration. So they parse, and `scripts/content-report.mjs` counts them.
 *   3. URLs ARE FREE TEXT. No picker means no validation upstream, so `.url()` is deliberately
 *      NOT used — a half-typed URL must render an empty slot, not fail a build.
 */

/** A visual slot: image or video, both optional, the whole object optional. */
const visual = z
  .object({
    /* ⚠︎ NO `text` HERE, AND THAT MATCHES `.pages.yml` (checked against origin/main,
     * 2026-08-23). `text` is offered on the GALLERIES only — cardGallery, technicalGallery
     * and the news gallery — never on a single-visual slot, because a landing image, a tab
     * image or a card cover cannot be prose. Keeping the enum narrow here means a text row
     * pasted into a cover slot fails the build instead of rendering as an empty box. */
    mediaType: z.enum(["image", "video"]).optional(),
    /* ⚠︎ TWO NAMES FOR THE URL, AND BOTH MUST PARSE. The CMS renamed `imageUrl` ->
     * `mediaUrl`, and the rename is a CORRECTION: `.pages.yml` has never offered a
     * `videoUrl` field at all, so this one string has always carried videos too — which is
     * why BEAM's .mp4s live in it. The data has not migrated.
     * ⛔ THIS IS THE `institutionSupport` BUG WITH A FAR BIGGER BLAST RADIUS: that was one
     * field on four files; this one carries EVERY visual on the site. Without both names
     * here, the first save through Pages CMS writes `mediaUrl`, Astro drops the unknown
     * key, and the image silently becomes a placeholder with no error anywhere.
     * map.ts prefers the new name and falls back to the old. */
    mediaUrl: z.string().optional(),
    imageUrl: z.string().optional(),
    videoUrl: z.string().optional(),
  })
  .partial()
  .optional();

/** A gallery row. `caption` is the first caption anywhere on the site (v5 opened this). */
const galleryRow = z
  .object({
    mediaType: z.enum(["image", "video", "text"]).optional(),
    mediaUrl: z.string().optional(),   // see the note on `visual` above — both names parse
    imageUrl: z.string().optional(),
    videoUrl: z.string().optional(),
    caption: z.string().optional(),
    /* ⭐ `textContent` IS THE REAL FIELD — confirmed against `.pages.yml` on origin/main,
     * 2026-08-23. It is `rich-text`, so it can carry markdown links and bold.
     * ⛔ THE EARLIER GUESS WAS WRONG AND FAILED SILENTLY. This accepted `text` and re-used
     * `caption`; the CMS uses neither, so `media()` found nothing, returned null, and every
     * text row was DROPPED with no error — across 10 files that already had them. The
     * guess was flagged as a guess at the time; it still cost a silent regression.
     * ⚠︎ `caption` is labelled "Image/Video Caption" in the CMS and belongs to media rows.
     * A text row never carries one. The two legacy names stay only as a cheap fallback. */
    textContent: z.string().optional(),
    text: z.string().optional(),
  })
  .partial();

/**
 * ⚠︎ A gallery is MIXED across real files right now:
 *   · 4 news files  -> ["/assets/SF-1.jpg", …]   legacy flat strings, origin deleted
 *   · 3 news files  -> [{}, {}, {}]              new-shape rows Xin created but left empty
 * The union parses both; the mapper normalises to one shape; the report counts which is which.
 */
const gallery = z.array(z.union([galleryRow, z.string()])).optional();

const artworks = defineCollection({
  loader: glob({ pattern: "*.md", base: "./content/artworks" }),
  schema: z.object({
    title: z.string(),
    // was `year: number` at the v4 audit; now a real date, month-precision (all day-01).
    productionDate: z.coerce.date().optional(),
    tagline: z.string().optional(),
    // 11/11 populated as of 2026-08-13 — the "medium/dimensions in or out" question,
    // open since Aug 5, is answered on the data side. Renders as grey text under the title.
    medium: z.string().optional(),
    size: z.string().optional(),
    duration: z.string().optional(),
    featured: z.boolean().default(false),
    featureOrder: z.number().optional(),
    premiereCity: z.string().optional(),
    exhibitions: z.string().optional(),
    artistStatement: z.string().optional(),
    /* ⚠︎ TWO NAMES FOR ONE FIELD, AND BOTH MUST PARSE (2026-08-23).
     * `.pages.yml` offers `institutionSupport`; all 11 content files still carry
     * `acknowledgements`; ZERO carry `institutionSupport`. So the CMS was renamed and the
     * data was never migrated — and because the schema knew only the old name, the first
     * time anyone edited that field in Pages CMS the value would have been written under
     * the new key and SILENTLY DROPPED by Astro. No error, no empty state, just gone.
     * Both are accepted; `map.ts` prefers the new name and falls back to the old. */
    acknowledgements: z.string().optional(),
    institutionSupport: z.string().optional(),
    technicalTagline: z.string().optional(),
    technicalText: z.string().optional(),
    landingVisual: visual,
    tabArtVisual: visual,
    cardCoverVisual: visual,
    cardGallery: gallery,
    technicalGallery: gallery,
  }),
});

const news = defineCollection({
  loader: glob({ pattern: "*.md", base: "./content/news" }),
  schema: z.object({
    title: z.string(),
    subheading: z.string().optional(),
    isDateRange: z.boolean().default(false),
    date: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    location: z.string().optional(),
    city: z.string().optional(),
    // All 5 values in use are valid. Kept as an enum deliberately: a sixth should FAIL the
    // build rather than render as a raw string, which is how the old off-schema
    // "Screening" value reached the site in the first place.
    eventType: z
      .enum(["Award", "Screening", "Solo exhibition", "Group exhibition", "Artist Talk", "Press"])
      .optional(),
    statement: z.string().optional(),
    mainVisual: visual,
    gallery,
    // ── legacy, tolerated so the build survives real content. See note 2 above.
    image: z.string().optional(),
    year: z.string().optional(), // one stray file, left over from the pre-`date` news model
  }),
});

const about = defineCollection({
  loader: glob({ pattern: "about.md", base: "./content" }),
  schema: z.object({
    bio: z.string().optional(),
    exhibitionsAppearances: z.string().optional(),
    awardsCommissions: z.string().optional(),
    pressMentions: z.string().optional(),
    // renamed from `image` on 2026-08-10; absent from the file today, so no profile picture
    // renders anywhere. Was already true before the rename — flagged in v4-cms-audit §3.
    // ⚠︎ and possibly renamed again to `mediaUrl` — both accepted, same reason as `visual`.
    mediaUrl: z.string().optional(),
    imageUrl: z.string().optional(),
  }),
});

const contact = defineCollection({
  loader: glob({ pattern: "contact.md", base: "./content" }),
  // The only surface in the whole CMS with complete data, which is why it got built first.
  schema: z.object({
    email: z.string().optional(),
    instagram: z.string().optional(),
  }),
});

export const collections = { artworks, news, about, contact };
