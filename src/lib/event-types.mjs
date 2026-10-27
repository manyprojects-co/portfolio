/**
 * event-types.mjs — the news `eventType` list, in ONE place.
 *
 * ⛔ WHY THIS FILE EXISTS (2026-10-27): `.pages.yml` gained `Commission` in its select on
 * 2026-10-26 (via the CMS); the enum in `content.config.ts` did not. The enum fails the build
 * on purpose (a sixth value must not render as a raw string), so every deploy from the next
 * CMS save onward failed and the live site froze — found a day later, by accident, building a
 * branch. Nothing compared the two lists. Now `content.config.ts` builds its enum from this
 * array and `scripts/content-report.mjs` compares it to `.pages.yml`'s select, so the next
 * drift is a report flag, not a dead deploy.
 *
 * ⚠︎ Adding a type: add it HERE and in `.pages.yml` (Pages CMS reads only the yml). The report
 * flags either side missing. Labels, where they differ from the raw value, are in format.ts.
 */
export const EVENT_TYPES = /** @type {const} */ ([
  "Award", "Screening", "Solo exhibition", "Group exhibition", "Artist Talk", "Press", "Commission",
]);
