/**
 * content-report.mjs — one screen of "what is actually in the CMS right now".
 *
 *   npm run data:report
 *
 * Two jobs. First, TRACK THE IMAGE MIGRATION: every visual field is empty today, and this
 * is how we watch them fill in without re-auditing by hand (v4-cms-audit.md took a session
 * and was obsolete in four days). Second, FLAG DATA-QUALITY ISSUES worth one message to Xin.
 */
import { readFileSync, existsSync } from "node:fs";
import { normaliseMediaUrl, looksLikeVideo, MEDIA_ORIGIN, MANIFEST_PATH } from "../src/lib/media-origin.mjs";
import { walkMediaRefs, fm, dir } from "./content-walk.mjs";
import { EVENT_TYPES } from "../src/lib/event-types.mjs";
import * as yaml from "js-yaml";

const arts = dir("content/artworks"), news = dir("content/news");
const has = (v) => v !== undefined && v !== null && v !== "" &&
  !(Array.isArray(v) && !v.length) && !(typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
const count = (rows, f) => rows.filter((r) => has(r.d[f])).length;
const bar = (n, t) => "█".repeat(Math.round((n / t) * 20)).padEnd(20, "·");
const row = (label, n, t) => console.log(`  ${label.padEnd(22)} ${bar(n, t)} ${String(n).padStart(2)}/${t}`);

console.log("\n═══ ARTWORKS (%d) ═══════════════════════════════════════", arts.length);
for (const f of ["title", "productionDate", "tagline", "medium", "size", "duration",
                 // ⚠︎ institutionSupport, NOT acknowledgements — the CMS renamed it and the
                 // content followed. Reporting the dead key showed a FALSE 0/11.
                 "premiereCity", "exhibitions", "artistStatement", "institutionSupport",
                 "featureOrder", "technicalTagline", "technicalText"])
  row(f, count(arts, f), arts.length);
console.log("  ── visuals ──");
for (const f of ["landingVisual", "tabArtVisual", "cardCoverVisual", "cardGallery", "technicalGallery"])
  row(f, count(arts, f), arts.length);

console.log("\n═══ NEWS (%d) ═══════════════════════════════════════════", news.length);
for (const f of ["title", "date", "eventType", "city", "location", "statement", "subheading"])
  row(f, count(news, f), news.length);
console.log("  ── visuals ──");
row("mainVisual (new)", count(news, "mainVisual"), news.length);
const legacyImg = news.filter((n) => typeof n.d.image === "string").length;
const galObj = news.filter((n) => (n.d.gallery ?? []).some((g) => typeof g === "object")).length;
/* ⭐ A ROW IS EMPTY ONLY IF IT CARRIES NOTHING — not merely because it is an object.
 * 🐞 The flag below used `galObj` (any object row) and read "15 news items have EMPTY
 * gallery rows". That was TRUE when every row really was a bare `{}`, and silently became
 * a false alarm on all 15 the moment the galleries were populated — the predicate never
 * tested emptiness at all.
 * ⛔ THIRD INSTANCE OF THIS EXACT FAILURE TODAY (imageUrl, acknowledgements, this): the
 * report describing a state that was true when it was written and is no longer checked.
 * ⚠︎ A TEXT ROW HAS NO URL BY DESIGN and must not count as empty — it carries textContent. */
const rowEmpty = (g) => {
  if (typeof g === "string") return !g.trim();
  if (!g || typeof g !== "object") return true;
  if (g.mediaType === "text") return !String(g.textContent ?? g.text ?? "").trim();
  return !String(g.mediaUrl ?? g.imageUrl ?? g.videoUrl ?? "").trim();
};
const galEmpty = news.filter((n) => (n.d.gallery ?? []).some(rowEmpty)).length;
const galStr = news.filter((n) => (n.d.gallery ?? []).some((g) => typeof g === "string")).length;
row("image (LEGACY)", legacyImg, news.length);
row("gallery new-shape", galObj, news.length);
row("gallery LEGACY str", galStr, news.length);

// ── every pasted URL, checked against the media origin ─────────────────────────────
// The CMS has no picker, so a typo or an r2.dev URL is a live possibility on every field.
/**
 * ⭐ ONE NORMALISER (2026-10-27). Host verdicts (r2.dev, off-origin) come from
 * `normaliseMediaUrl` in `src/lib/media-origin.mjs` — the function Media.astro renders with
 * and media-dims.mjs keys the manifest with. This script used to carry its own copy of the
 * host rules, which is how two normalisations came to exist (brief, T1). What stays here is
 * LINT the normaliser does not do, because it accepts those URLs and they still break:
 * ⚠︎ A MALFORMED PATH ON THE *CORRECT* HOST used to pass clean — `…/box-body/ bb-art1.jpg`
 * (a stray space, six of them in one file) reported as valid and produced six broken images.
 * `new URL()` percent-encodes the space to `/%20bb-art1.jpg`, which matches no R2 object,
 * so nothing throws and nothing 404s at build time — it just serves a broken picture.
 * Whitespace is the one an editor pasting by hand will keep producing.
 *
 * ⛔ THIS SCRIPT WAS SILENTLY VALIDATING NOTHING (found 2026-08-23). It read `imageUrl`
 * only; the CMS had renamed the field to `mediaUrl`, so every migrated file's URLs were
 * skipped and the report printed "0 invalid URLs". The walk now lives in content-walk.mjs
 * and yields BOTH names, and the manifest script walks the same way.
 */
const badUrls = [];
function checkUrl(where, raw) {
  const v = String(raw ?? "").trim();
  if (!v) return;
  if (v.startsWith("/assets/")) return;                       // legacy, already flagged
  const verdict = normaliseMediaUrl(v);
  if (!verdict.ok) { badUrls.push(`${where}: ${verdict.reason}. ${v.slice(0, 60)}`); return; }
  if (/\s/.test(v))
    badUrls.push(`${where}: WHITESPACE inside the URL — resolves to %20 and will 404. ${v.slice(0, 70)}`);
  else if (/(?<!:)\/\//.test(v.replace(/^https?:\/\//, "")))
    badUrls.push(`${where}: double slash in the path. ${v.slice(0, 70)}`);
}
const refs = [...walkMediaRefs()];
for (const r of refs) if (!r.legacy && r.field !== "faviconUrl") checkUrl(r.where, r.raw);

// ── the manifest, policed (brief, T3 + T1) ───────────────────────────────────────────
/**
 * `content/media-dimensions.json` is written by `npm run media:dims` on JJ's machine and
 * read by Media.astro at build. Nothing else checks it, and a stale manifest does not throw —
 * a missing entry just means that image loads zero-width as it did before (R1). So the
 * report says, every run:
 *   · how many image URLs have NO entry (the normal steady state is a few: Xin pastes a URL,
 *     the CMS commits, the manifest trails by one commit until JJ next runs the script — N6)
 *   · entries whose URL no longer appears in content (the script's --prune removes them)
 *   · any key that is not its own normalised form — the one failure that would make EVERY
 *     lookup miss silently (T1)
 */
const manifest = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) : null;
const imageKeys = new Set();
for (const r of refs) {
  if (r.legacy || r.field === "faviconUrl" || r.field === "videoUrl") continue;
  if (r.declaredType === "video" || looksLikeVideo(r.raw)) continue;
  const v = normaliseMediaUrl(r.raw);
  if (v.ok) imageKeys.add(v.url);
}
const manifestFlags = [];
if (!manifest) {
  manifestFlags.push(`${MANIFEST_PATH} is MISSING — the build will fail (Media.astro imports it). Restore \`{}\` at least.`);
} else {
  const keys = Object.keys(manifest);
  const noEntry = [...imageKeys].filter((k) => !(k in manifest));
  const orphans = keys.filter((k) => !imageKeys.has(k));
  const badKeys = keys.filter((k) => { const v = normaliseMediaUrl(k); return !v.ok || v.url !== k; });
  const badShape = keys.filter((k) => !(manifest[k] && manifest[k].w > 0 && manifest[k].h > 0));
  if (noEntry.length) manifestFlags.push(
    `${noEntry.length} of ${imageKeys.size} image URLs have NO manifest entry — those images load\n` +
    `     zero-width until \`npm run media:dims\` is run and committed (JJ's terminal).` +
    (noEntry.length <= 12 ? "\n" + noEntry.map((k) => `       · ${k.replace(/^https:\/\/[^/]+/, "")}`).join("\n") : ""));
  if (orphans.length) manifestFlags.push(
    `${orphans.length} manifest entr${orphans.length === 1 ? "y" : "ies"} for URLs no longer in content — harmless; \`npm run media:dims -- --prune\` drops them.`);
  if (badKeys.length) manifestFlags.push(
    `⛔ ${badKeys.length} manifest key(s) are NOT in normalised form — Media.astro looks up by the normalised URL,\n` +
    `     so these entries can never match. First: ${badKeys[0]}`);
  if (badShape.length) manifestFlags.push(
    `⛔ ${badShape.length} manifest entr${badShape.length === 1 ? "y" : "ies"} without w/h > 0 — first: ${badShape[0]}`);
}

console.log("\n═══ MANIFEST ════════════════════════════════════════════");
if (manifest) {
  const n = Object.keys(manifest).length, covered = [...imageKeys].filter((k) => k in manifest).length;
  row("image URLs w/ dims", covered, imageKeys.size);
  console.log(`  ${String(n).padStart(4)} entries in ${MANIFEST_PATH}`);
}
console.log("\n═══ ⚠︎  FLAGS ═══════════════════════════════════════════");
const flags = [...badUrls, ...manifestFlags];
const totalVisuals = ["landingVisual", "tabArtVisual", "cardCoverVisual"]
  .reduce((a, f) => a + count(arts, f), 0);
if (!totalVisuals) flags.push(
  `NO ARTWORK HAS ANY VISUAL. All ${arts.length} works, all 3 slots, empty. The repo holds\n` +
  `     zero image files since 087aee8 (2026-08-10) and the CMS has no media picker, so every\n` +
  `     image is a hand-pasted Cloudflare URL. This is the blocker for the whole visual layer.`);
if (legacyImg) flags.push(
  `${legacyImg} news items still use the flat \`image:\` field pointing at /assets/… — an origin\n` +
  `     DELETED on 2026-08-10. These resolve to nothing today.`);
if (galEmpty) flags.push(
  `${galEmpty} news items have gallery rows that carry NOTHING — slots created in\n` +
  `     the CMS UI but no URL pasted yet. Migration in progress, not finished.`);
// ── the eventType list, compared to .pages.yml (2026-10-27) ──────────────────────────
/* ⛔ `.pages.yml` gained `Commission` on 2026-10-26 and the schema enum did not; the build
 * failed on the next CMS save and nobody was told. The schema now reads `EVENT_TYPES`; this
 * compares that list to the yml's select so the two cannot drift silently again. */
{ const yml = yaml.load(readFileSync(".pages.yml", "utf8"));
  const findSelect = (node) => { if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) { for (const x of node) { const r = findSelect(x); if (r) return r; } return null; }
    if (node.name === "eventType" && node.options?.values) return node.options.values;
    for (const v of Object.values(node)) { const r = findSelect(v); if (r) return r; } return null; };
  const ymlTypes = findSelect(yml);
  if (!ymlTypes) flags.push("⛔ could not find the eventType select in .pages.yml — the report cannot compare it to the schema.");
  else {
    const onlyYml = ymlTypes.filter((t) => !EVENT_TYPES.includes(t));
    const onlySchema = EVENT_TYPES.filter((t) => !ymlTypes.includes(t));
    if (onlyYml.length) flags.push(`⛔ eventType in .pages.yml but NOT in the schema: ${onlyYml.join(", ")} — the first CMS save using it FAILS THE BUILD. Add to src/lib/event-types.mjs.`);
    if (onlySchema.length) flags.push(`eventType in the schema but not offered by .pages.yml: ${onlySchema.join(", ")} — harmless; editors cannot pick it.`);
  }
  for (const n of news) if (n.d.eventType && !EVENT_TYPES.includes(n.d.eventType))
    flags.push(`⛔ news/${n.slug}: eventType "${n.d.eventType}" is not in the schema — THIS FILE FAILS THE BUILD.`);
}
for (const n of news) {
  if (n.d.isDateRange === false && n.d.endDate)
    flags.push(`news/${n.slug}: isDateRange is false but endDate is set (${String(n.d.endDate).slice(0, 10)}).`);
  if (n.d.year) flags.push(`news/${n.slug}: stray \`year: ${n.d.year}\` — not in the schema, pre-date model leftover.`);
}
// 2026-09-30: the grid caption's second line is `tagline` ("Work Type" in the CMS), not premiereCity.
for (const a of arts) if (!has(a.d.tagline)) flags.push(`artworks/${a.slug}: no tagline (Work Type) — grid caption is title + year only.`);
// ✅ RESOLVED 2026-08-13 (JJ): personhood should NOT show a range. v6 displayed
// "2024 - 2026"; the CMS has always said 2024-10-01 and that is correct. This was
// prototype drift, not a schema gap — the port already renders "2024". No flag.
{ const ab = fm("content/about.md");
  if (!has(ab.mediaUrl ?? ab.imageUrl))
    flags.push("about.mediaUrl is empty — the bio's portrait (below Press & Mentions) will not render.");
  // (a pasted about URL is already checked by the shared walk above)
  // favicon (2026-09-30): optional, but if pasted it must be a real media-origin URL
  if (has(ab.faviconUrl)) checkUrl("about faviconUrl", String(ab.faviconUrl));
  else flags.push("about.faviconUrl is empty — the site has no favicon (browser default)."); }
flags.forEach((f, i) => console.log(`  ${String(i + 1).padStart(2)}. ${f}`));
console.log("");
