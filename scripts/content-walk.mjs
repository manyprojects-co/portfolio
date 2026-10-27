/**
 * content-walk.mjs — every pasted media URL in `content/`, one place.
 *
 * Shared by `content-report.mjs` (validate) and `media-dims.mjs` (measure) so the two can
 * never disagree about what counts as a URL. ⛔ Both scripts used to be candidates for their
 * own walk, and a private walk is how `content-report.mjs` once read `imageUrl` only and
 * reported "0 invalid URLs" for weeks while the CMS had moved to `mediaUrl`.
 *
 * ⚠︎ BOTH NAMES, ALWAYS. `content.config.ts` accepts `mediaUrl` AND `imageUrl` on every
 * visual, deliberately. Today 0 files use `imageUrl`; the day one does, a `mediaUrl`-only
 * walk silently drops that image (brief, T11). This yields each key separately, so an
 * object carrying both yields twice — the report checks both, the manifest measures both.
 *
 * Frontmatter is read with js-yaml, not through Astro, so the scripts run in plain node
 * with no build and no `.astro/data-store.json` cache in the way (brief, T5).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

export const fm = (p) => {
  const t = readFileSync(p, "utf8");
  return t.startsWith("---") ? yaml.load(t.split(/^---$/m)[1]) ?? {} : {};
};
export const dir = (d) => readdirSync(d).filter((f) => f.endsWith(".md"))
  .map((f) => ({ slug: f.replace(/\.md$/, ""), d: fm(path.join(d, f)) }));

/** The three URL-bearing keys a visual or gallery row can carry. */
const URL_KEYS = ["mediaUrl", "imageUrl", "videoUrl"];

/**
 * @typedef {{ where: string, field: "mediaUrl"|"imageUrl"|"videoUrl"|"faviconUrl",
 *             raw: string, declaredType: string|undefined, legacy: boolean }} MediaRef
 */

/** @returns {Generator<MediaRef>} */
function* refsFrom(where, o) {
  if (!o || typeof o !== "object") return;
  if (o.mediaType === "text") return;                 // a text row has no URL by design
  for (const k of URL_KEYS) {
    const v = o[k];
    if (typeof v === "string" && v.trim())
      yield { where, field: k, raw: v, declaredType: o.mediaType, legacy: false };
  }
}

/**
 * Walk artworks, news and about. Legacy flat `/assets/…` strings are yielded with
 * `legacy: true` so the report can count them; they never reach the manifest (origin deleted
 * 2026-08-10).
 * @param {string} [root] repo root; defaults to cwd
 * @returns {Generator<MediaRef>}
 */
export function* walkMediaRefs(root = process.cwd()) {
  const at = (p) => path.join(root, p);
  for (const [kind, d] of [["artworks", "content/artworks"], ["news", "content/news"]]) {
    for (const r of dir(at(d))) {
      for (const [k, val] of Object.entries(r.d)) {
        const where = `${kind}/${r.slug} ${k}`;
        if (val && typeof val === "object" && !Array.isArray(val)) yield* refsFrom(where, val);
        // legacy flat gallery strings are skipped here (refsFrom ignores non-objects); the
        // report tallies them from the frontmatter directly
        if (Array.isArray(val)) for (const [i, row] of val.entries()) yield* refsFrom(`${where}[${i}]`, row);
        if (k === "image" && typeof val === "string" && val.trim())
          yield { where, field: "mediaUrl", raw: val, declaredType: undefined, legacy: true };
      }
    }
  }
  const aboutPath = at("content/about.md");
  if (existsSync(aboutPath)) {
    const ab = fm(aboutPath);
    for (const k of ["mediaUrl", "imageUrl"])
      if (typeof ab[k] === "string" && ab[k].trim())
        yield { where: `about ${k}`, field: k, raw: ab[k], declaredType: undefined, legacy: false };
    if (typeof ab.faviconUrl === "string" && ab.faviconUrl.trim())
      yield { where: "about faviconUrl", field: "faviconUrl", raw: ab.faviconUrl, declaredType: undefined, legacy: false };
  }
}
