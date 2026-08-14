/**
 * content-report.mjs — one screen of "what is actually in the CMS right now".
 *
 *   npm run data:report
 *
 * Two jobs. First, TRACK THE IMAGE MIGRATION: every visual field is empty today, and this
 * is how we watch them fill in without re-auditing by hand (v4-cms-audit.md took a session
 * and was obsolete in four days). Second, FLAG DATA-QUALITY ISSUES worth one message to Xin.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const fm = (p) => { const t = readFileSync(p, "utf8");
  return t.startsWith("---") ? yaml.load(t.split(/^---$/m)[1]) ?? {} : {}; };
const dir = (d) => readdirSync(d).filter((f) => f.endsWith(".md"))
  .map((f) => ({ slug: f.replace(/\.md$/, ""), d: fm(path.join(d, f)) }));

const arts = dir("content/artworks"), news = dir("content/news");
const has = (v) => v !== undefined && v !== null && v !== "" &&
  !(Array.isArray(v) && !v.length) && !(typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
const count = (rows, f) => rows.filter((r) => has(r.d[f])).length;
const bar = (n, t) => "█".repeat(Math.round((n / t) * 20)).padEnd(20, "·");
const row = (label, n, t) => console.log(`  ${label.padEnd(22)} ${bar(n, t)} ${String(n).padStart(2)}/${t}`);

console.log("\n═══ ARTWORKS (%d) ═══════════════════════════════════════", arts.length);
for (const f of ["title", "productionDate", "tagline", "medium", "size", "duration",
                 "premiereCity", "exhibitions", "artistStatement", "acknowledgements",
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
const galStr = news.filter((n) => (n.d.gallery ?? []).some((g) => typeof g === "string")).length;
row("image (LEGACY)", legacyImg, news.length);
row("gallery new-shape", galObj, news.length);
row("gallery LEGACY str", galStr, news.length);

// ── every pasted URL, checked against the media origin ─────────────────────────────
// The CMS has no picker, so a typo or an r2.dev URL is a live possibility on every field.
const MEDIA_ORIGIN = "media.agawen.com";   // R2 bucket `agawen-media`
const badUrls = [];
function checkUrl(where, raw) {
  const v = String(raw ?? "").trim();
  if (!v) return;
  if (v.startsWith("/assets/")) return;                       // legacy, already flagged
  if (v.includes(".r2.dev"))
    badUrls.push(`${where}: r2.dev URL — CANNOT be transformed. Use ${MEDIA_ORIGIN}.`);
  else if (v.startsWith("http") && !v.includes(MEDIA_ORIGIN) && !v.includes("agawen.com"))
    badUrls.push(`${where}: off-origin host — transforms will be rejected. ${v.slice(0, 60)}`);
}
function walkVisuals(rows, kind) {
  for (const r of rows) {
    for (const [k, val] of Object.entries(r.d)) {
      if (val && typeof val === "object" && !Array.isArray(val))
        checkUrl(`${kind}/${r.slug} ${k}`, val.imageUrl || val.videoUrl);
      if (Array.isArray(val))
        val.forEach((row, i) => { if (row && typeof row === "object")
          checkUrl(`${kind}/${r.slug} ${k}[${i}]`, row.imageUrl || row.videoUrl); });
    }
  }
}
walkVisuals(arts, "artworks"); walkVisuals(news, "news");

console.log("\n═══ ⚠︎  FLAGS ═══════════════════════════════════════════");
const flags = [...badUrls];
const totalVisuals = ["landingVisual", "tabArtVisual", "cardCoverVisual"]
  .reduce((a, f) => a + count(arts, f), 0);
if (!totalVisuals) flags.push(
  `NO ARTWORK HAS ANY VISUAL. All ${arts.length} works, all 3 slots, empty. The repo holds\n` +
  `     zero image files since 087aee8 (2026-08-10) and the CMS has no media picker, so every\n` +
  `     image is a hand-pasted Cloudflare URL. This is the blocker for the whole visual layer.`);
if (legacyImg) flags.push(
  `${legacyImg} news items still use the flat \`image:\` field pointing at /assets/… — an origin\n` +
  `     DELETED on 2026-08-10. These resolve to nothing today.`);
if (galObj) flags.push(
  `${galObj} news items have new-shape gallery rows that are EMPTY objects — slots created in\n` +
  `     the CMS UI but no URL pasted yet. Migration in progress, not finished.`);
for (const n of news) {
  if (n.d.isDateRange === false && n.d.endDate)
    flags.push(`news/${n.slug}: isDateRange is false but endDate is set (${String(n.d.endDate).slice(0, 10)}).`);
  if (n.d.year) flags.push(`news/${n.slug}: stray \`year: ${n.d.year}\` — not in the schema, pre-date model leftover.`);
}
for (const a of arts) if (!has(a.d.premiereCity)) flags.push(`artworks/${a.slug}: no premiereCity — grid caption will be bare.`);
// ✅ RESOLVED 2026-08-13 (JJ): personhood should NOT show a range. v6 displayed
// "2024 - 2026"; the CMS has always said 2024-10-01 and that is correct. This was
// prototype drift, not a schema gap — the port already renders "2024". No flag.
if (!has(fm("content/about.md").imageUrl))
  flags.push("about.imageUrl is empty — no profile picture renders anywhere.");
flags.forEach((f, i) => console.log(`  ${String(i + 1).padStart(2)}. ${f}`));
console.log("");
