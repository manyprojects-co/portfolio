/**
 * media-origin.mjs — where images live, and the guard around hand-pasted URLs.
 *
 * ⭐ ONE NORMALISER, THREE CALLERS (2026-10-27). This file is plain JavaScript on purpose.
 * `Media.astro` (via `media-origin.ts`, which re-exports it with types),
 * `scripts/content-report.mjs` and `scripts/media-dims.mjs` all import THIS function, so a
 * URL produces the same string everywhere it is looked at. That matters because
 * `content/media-dimensions.json` is keyed on the normalised URL: if the script that writes
 * the key and the component that reads it normalised differently, every lookup would miss,
 * nothing would throw, and every image would silently keep its old zero-width load
 * (`placeholder-fork-brief.md` T1 — the `textContent` bug in another coat). The TypeScript
 * version used to live alone in `media-origin.ts`; `content-report.mjs` could not import it
 * (no tsx, no build step for scripts/) and had grown its own checks — two normalisers already.
 *
 * ⚠︎ THE CMS HAS NO MEDIA PICKER. The `media:` block was removed from `.pages.yml` on
 * 2026-08-10, so every image URL is typed or pasted by hand into a free-text field with
 * no validation upstream. There is exactly one wrong answer that LOOKS right — an
 * `r2.dev` URL, which Cloudflare offers in the R2 UI and which can never be transformed
 * (it is outside the zone, rate-limited, and documented as non-production). It will serve
 * an image in dev and quietly fail to optimise in production.
 *
 * So the guard lives here, and `npm run data:report` flags anything off-origin.
 */

/** R2 bucket `agawen-media`, exposed on the zone as this custom domain (JJ, 2026-08-13). */
export const MEDIA_ORIGIN = "media.agawen.com";

/** Transformations are SERVED from the apex; sources are allowed via `*.agawen.com`. */
export const TRANSFORM_HOST = "agawen.com";

/**
 * @typedef {{ ok: true, url: string, note?: string } | { ok: false, url: string, reason: string }} UrlVerdict
 */

/**
 * Normalise whatever an editor pasted into an absolute URL on the media origin.
 * Accepts: a full https URL, a protocol-relative URL, or a bare path.
 * Rejects: r2.dev, and anything on a host outside the allowlisted zone.
 *
 * ⚠︎ THE TWO BRANCHES RETURN DIFFERENT STRING SHAPES. A bare path is concatenated and is
 * NOT percent-encoded; an absolute URL goes through `new URL()` and comes back as
 * `u.toString()`, which is. Neither is wrong, but it is why the manifest key must always
 * be `verdict.url` from this function and never the raw pasted string.
 *
 * @param {string | undefined | null} raw
 * @returns {UrlVerdict}
 */
export function normaliseMediaUrl(raw) {
  const s = (raw ?? "").trim();
  if (!s) return { ok: false, url: "", reason: "empty" };

  // a bare path -> assume the media origin
  if (s.startsWith("/")) return { ok: true, url: `https://${MEDIA_ORIGIN}${s}` };

  let u;
  try {
    u = new URL(s.startsWith("//") ? `https:${s}` : s);
  } catch {
    return { ok: false, url: s, reason: "not a valid URL" };
  }

  if (u.hostname.endsWith(".r2.dev")) {
    return {
      ok: false, url: s,
      reason: `r2.dev cannot be transformed — use https://${MEDIA_ORIGIN}${u.pathname}`,
    };
  }
  if (u.hostname !== MEDIA_ORIGIN && !u.hostname.endsWith(`.${TRANSFORM_HOST}`) &&
      u.hostname !== TRANSFORM_HOST) {
    return {
      ok: false, url: s,
      reason: `host "${u.hostname}" is outside the allowed sources (*.${TRANSFORM_HOST})`,
    };
  }
  return { ok: true, url: u.toString() };
}

/**
 * Video by extension. Lives here (not in map.ts) so the manifest script can skip videos
 * BEFORE fetching: `/cdn-cgi/image/format=json` returns 404 for an .mp4 (verified
 * 2026-09-07), and a 404 must mean "broken URL", not "this is a video" (brief, T2).
 * `map.ts` re-exports it; the rule is identical on both sides by construction.
 */
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)(?:[?#]|$)/i;
/** @param {string} u */
export const looksLikeVideo = (u) => VIDEO_EXT.test(u);

/**
 * The manifest, `content/media-dimensions.json`: one entry per normalised image URL,
 * `{ w, h, bytes }` from the edge (`media:dims`), later `lqip` (BLUR). Read with this so the
 * component, the report and the script agree on the shape. A missing or empty file is `{}`
 * — the manifest is an optimisation, never a requirement (brief, R1).
 * @typedef {{ w: number, h: number, bytes?: number, lqip?: string }} MediaDims
 */
export const MANIFEST_PATH = "content/media-dimensions.json";
