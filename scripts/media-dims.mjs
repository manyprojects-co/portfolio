/**
 * media-dims.mjs — build `content/media-dimensions.json`, the committed image manifest.
 *
 *   npm run media:dims              measure every image URL not yet in the manifest
 *   npm run media:dims -- --refresh re-measure everything (after a re-upload)
 *   npm run media:dims -- --prune   also drop entries whose URL no longer appears in content
 *   npm run media:dims -- --dry-run report, write nothing
 *   npm run media:dims -- --no-lqip dimensions only (skip the LQIP transform)
 *
 * WHY (placeholder-fork-brief.md § MANIFEST): `Media.astro` emits `width`/`height` on every
 * real <img> from this file, so the browser knows each image's ratio before a byte lands and
 * the carousel reserves its full scroll width instead of growing as images arrive. The
 * numbers come from Cloudflare's edge — `GET /cdn-cgi/image/format=json/<url>` — once, here,
 * and are committed. The build reads the file and never the network.
 *
 * ⛔ THIS IS A JJ-TERMINAL COMMAND. A Claude session over the device bridge has no egress to
 * agawen.com; it can edit this script but cannot run it. Run it, read the summary, review the
 * diff, commit, push.
 *
 * RULES it keeps (the brief's R/T numbers):
 *   T1  the key is `normaliseMediaUrl(raw).url` — the SAME function Media.astro looks up by.
 *   T2  videos are skipped by extension/declaration BEFORE any fetch; a 404 here is a broken
 *       URL, never "this was a video".
 *   T11 `mediaUrl` and `imageUrl` are both walked (content-walk.mjs).
 *   R1  a miss is reported, never written as a broken entry; the component degrades.
 *   R2  only missing keys are fetched (each format=json may be a billed transformation).
 *   N3  one entry per line, keys sorted — a CMS merge conflict is per-image, not whole-file.
 *   N7  `bytes` is recorded and oversized masters are warned about.
 *
 * LQIP (BLUR, 2026-10-27): the same pass also records `lqip`, a base64 data: URL of the
 * image at `LQIP_WIDTH` px, which Media.astro inlines as a `background-image` under the real
 * <img> — the work's own blurred impression while the bytes are in flight (brief, tier 3).
 * It is fetched from the same edge (`width=16,format=webp,quality=30`) and, like w/h, only
 * for entries that lack it, so a manifest written before BLUR existed is topped up, never
 * rewritten. ⚠︎ `Accept: image/webp` MUST be sent: without it the edge answers a PNG source
 * with a PNG (~500 B) instead of a WebP (~140–460 B). Measured 2026-10-27 on the live edge:
 * JPEG source 92 B, opaque PNG 138 B, alpha PNG 328 B at q30 — budget ~200–600 B of base64
 * per image, not the brief's ~135.
 * ▪︎ Alpha is PRESERVED in the WebP. 20 of the 27 PNGs are transparent (all 16 `25pcm-art*`
 *   and 4 tabs), and the LQIP of each is transparent too, so the impression composites on
 *   whatever ground the surface paints. Nothing here flattens (`background=` would bake one
 *   surface's colour into a per-URL file). The "LQIP shows through the holes after load"
 *   trap (T6) is closed in site.js by clearing the background once the image is complete.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { normaliseMediaUrl, looksLikeVideo, TRANSFORM_HOST, MANIFEST_PATH } from "../src/lib/media-origin.mjs";
import { walkMediaRefs } from "./content-walk.mjs";

const args = new Set(process.argv.slice(2));
const REFRESH = args.has("--refresh"), PRUNE = args.has("--prune"), DRY = args.has("--dry-run");
const CONCURRENCY = 4;
const TIMEOUT_MS = 15_000;
/** [TUNE] research-notes §5 asks for an upload cap and nothing enforces one. Warn above this. */
const MAX_MASTER_BYTES = 1_500_000;
/** [TUNE] the LQIP transform. 16px is the brief's figure; the browser's upscale of it IS the
 *  blur (N4) — no filter on the placeholder. Changing either invalidates every entry: re-run
 *  with `--refresh` (R2 says the free tier can take one full pass, not one per build). */
const LQIP_WIDTH = 16;
const LQIP_QUALITY = 30;
const WANT_LQIP = !args.has("--no-lqip");
const complete = (e) => e && e.w > 0 && e.h > 0 && (!WANT_LQIP || typeof e.lqip === "string");

// ── 1. what the content refers to ─────────────────────────────────────────────────────
const wanted = new Map();            // key -> first `where` that uses it
const skipped = { video: 0, bad: [], favicon: 0, legacy: 0 };
for (const ref of walkMediaRefs()) {
  if (ref.legacy) { skipped.legacy++; continue; }
  if (ref.field === "faviconUrl") { skipped.favicon++; continue; }      // a <link>, not an <img>
  if (ref.field === "videoUrl" || ref.declaredType === "video" || looksLikeVideo(ref.raw)) { skipped.video++; continue; }
  const v = normaliseMediaUrl(ref.raw);
  if (!v.ok) { skipped.bad.push(`${ref.where}: ${v.reason}`); continue; }   // data:report owns these
  if (!wanted.has(v.url)) wanted.set(v.url, ref.where);
}

// ── 2. what the manifest already knows ────────────────────────────────────────────────
const existing = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) : {};
const next = { ...existing };
let pruned = 0;
if (PRUNE) for (const k of Object.keys(next)) if (!wanted.has(k)) { delete next[k]; pruned++; }

const toFetch = [...wanted.keys()].filter((k) => REFRESH || !complete(existing[k]));
console.log(`\n═══ media:dims ═══════════════════════════════════════════`);
console.log(`  content refers to ${wanted.size} image URL(s); manifest holds ${Object.keys(existing).length}`);
console.log(`  skipped: ${skipped.video} video, ${skipped.favicon} favicon, ${skipped.legacy} legacy, ${skipped.bad.length} invalid (see data:report)`);
console.log(`  to fetch: ${toFetch.length}${REFRESH ? " (--refresh)" : ""}${PRUNE ? `; pruned ${pruned}` : ""}\n`);

// ── 3. ask the edge ───────────────────────────────────────────────────────────────────
const notFound = [], failed = [], oversized = [];
let lqipBytes = 0, lqipCount = 0;
const edge = (opts, key, signal, headers) =>
  fetch(`https://${TRANSFORM_HOST}/cdn-cgi/image/${opts}/${key}`, { signal, headers });

async function measure(key) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const have = next[key] ?? {};
  try {
    // ── dimensions (MANIFEST) — only if this entry has none ──────────────────────────
    if (REFRESH || !(have.w > 0 && have.h > 0)) {
      const res = await edge("format=json", key, ac.signal);
      if (res.status === 404) { notFound.push(key); return; }
      if (!res.ok) { failed.push(`${key}: HTTP ${res.status}`); return; }
      const j = await res.json();
      const w = j?.original?.width ?? j?.width, h = j?.original?.height ?? j?.height;
      const bytes = j?.original?.file_size;
      if (!(w > 0 && h > 0)) { failed.push(`${key}: no dimensions in response`); return; }
      next[key] = { ...have, w, h, ...(bytes ? { bytes } : {}) };
      if (bytes > MAX_MASTER_BYTES) oversized.push(`${(bytes / 1e6).toFixed(1)}MB  ${key}`);
    }
    // ── LQIP (BLUR) — only if this entry has none ────────────────────────────────────
    let lq = "";
    if (WANT_LQIP && (REFRESH || typeof next[key].lqip !== "string")) {
      const res = await edge(`width=${LQIP_WIDTH},format=webp,quality=${LQIP_QUALITY}`, key, ac.signal,
                             { Accept: "image/webp,image/*;q=0.8" });
      if (!res.ok) { failed.push(`${key}: lqip HTTP ${res.status}`); return; }
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!type.startsWith("image/")) { failed.push(`${key}: lqip is ${type || "untyped"}, not an image`); return; }
      const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      next[key] = { ...next[key], lqip: `data:${type};base64,${b64}` };
      lqipBytes += b64.length; lqipCount++;
      lq = `  lqip ${String(b64.length).padStart(4)}B${type !== "image/webp" ? ` ⚠︎ ${type}` : ""}`;
    }
    const { w, h } = next[key];
    process.stdout.write(`  ${String(w).padStart(5)}×${String(h).padEnd(5)}${lq}  ${key.replace(/^https:\/\/[^/]+/, "")}\n`);
  } catch (e) {
    failed.push(`${key}: ${e.name === "AbortError" ? "timeout" : e.message}`);
  } finally { clearTimeout(t); }
}
const queue = [...toFetch];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) await measure(queue.shift());
}));

// ── 4. write: sorted keys, one entry per line (N3) ────────────────────────────────────
const keys = Object.keys(next).sort();
const out = keys.length
  ? "{\n" + keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(next[k])}`).join(",\n") + "\n}\n"
  : "{}\n";
if (!DRY) writeFileSync(MANIFEST_PATH, out);

// ── 5. summary — read this before committing ──────────────────────────────────────────
console.log(`\n═══ summary ══════════════════════════════════════════════`);
console.log(`  manifest: ${keys.length} entr${keys.length === 1 ? "y" : "ies"}${DRY ? " (dry run, not written)" : ` → ${MANIFEST_PATH}`}`);
const stillMissing = [...wanted.keys()].filter((k) => !(k in next)).length;
console.log(`  image URLs without an entry: ${stillMissing}`);
if (WANT_LQIP) {
  const noLqip = keys.filter((k) => typeof next[k].lqip !== "string").length;
  console.log(`  lqip: ${lqipCount} fetched this run (${(lqipBytes / 1024).toFixed(1)} KB of base64); entries still without one: ${noLqip}`);
}
if (notFound.length) {
  console.log(`\n  ⚠︎ ${notFound.length} URL(s) the edge cannot find — a 404 from the REAL origin, so the path is wrong`);
  console.log(`    or the object was never uploaded. These are broken on the live site today:`);
  for (const k of notFound) console.log(`    404  ${k}   (${wanted.get(k)})`);
}
if (failed.length) {
  console.log(`\n  ⛔ ${failed.length} request(s) failed — not written; re-run to retry:`);
  for (const f of failed) console.log(`    ${f}`);
}
if (oversized.length) {
  console.log(`\n  ▪︎ ${oversized.length} master(s) over ${(MAX_MASTER_BYTES / 1e6).toFixed(1)}MB (research-notes §5 upload cap, unenforced):`);
  for (const o of oversized) console.log(`    ${o}`);
}
if (skipped.bad.length) {
  console.log(`\n  ▪︎ ${skipped.bad.length} URL(s) skipped as invalid — \`npm run data:report\` has the detail`);
}
console.log("");
process.exitCode = failed.length ? 1 : 0;
