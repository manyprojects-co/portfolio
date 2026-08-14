/**
 * media-origin.ts — where images live, and the guard around hand-pasted URLs.
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

export type UrlVerdict =
  | { ok: true; url: string; note?: string }
  | { ok: false; url: string; reason: string };

/**
 * Normalise whatever an editor pasted into an absolute URL on the media origin.
 * Accepts: a full https URL, a protocol-relative URL, or a bare path.
 * Rejects: r2.dev, and anything on a host outside the allowlisted zone.
 */
export function normaliseMediaUrl(raw: string | undefined | null): UrlVerdict {
  const s = (raw ?? "").trim();
  if (!s) return { ok: false, url: "", reason: "empty" };

  // a bare path -> assume the media origin
  if (s.startsWith("/")) return { ok: true, url: `https://${MEDIA_ORIGIN}${s}` };

  let u: URL;
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
