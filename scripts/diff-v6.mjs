/**
 * diff-v6.mjs — compares live CMS content, through the mapper, against the inline `works`
 * and `news` arrays in prototype-v6.html.
 *
 *   node scripts/diff-v6.mjs /path/to/prototype-v6.html
 *
 * ONE-TIME MIGRATION CHECK, not a CI test. v6 lives in the design workspace (MP_CMS_CF),
 * not this repo, so the path is an argument. The point is to make every intentional
 * difference visible and catch unintentional ones — v6's data is a 2026-08-06 snapshot
 * against a schema that has since changed twice, so DIFFERENCES ARE EXPECTED. What is not
 * expected is a field that should have carried over and didn't.
 */
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const V6 = process.argv[2];
if (!V6) { console.error("usage: node scripts/diff-v6.mjs <path to prototype-v6.html>"); process.exit(2); }

// ── pull the two inline arrays straight out of the prototype ────────────────────────────
function inlineArray(src, name) {
  const start = src.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`${name} not found`);
  let i = src.indexOf("[", start), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "[") depth++;
    else if (src[j] === "]") { depth--; if (!depth) { end = j + 1; break; } }
  }
  // v6 builds news image URLs from a NEWS_CDN const; supply it so the array evaluates.
  // v6 builds some values from helpers in its own scope; supply stubs so the array evaluates.
  return new Function("NEWS_CDN", "placeholder",
    `return ${src.slice(i, end)}`)("", () => "");
}
const html = readFileSync(V6, "utf8");
const v6Works = inlineArray(html, "works");
const v6News  = inlineArray(html, "news");

// ── read the CMS the same way the collections do, minus Astro ───────────────────────────
const fm = (p) => {
  const t = readFileSync(p, "utf8");
  return t.startsWith("---") ? yaml.load(t.split(/^---$/m)[1]) ?? {} : {};
};
const dir = (d) => readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => ({
  slug: f.replace(/\.md$/, ""), data: fm(path.join(d, f)),
}));

const lines = (s) => !s ? [] : String(s).split("\n").map((l) => l.trim()).filter(Boolean);
const paras = (s) => !s ? [] : String(s).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const norm  = (s) => String(s ?? "").replace(/&amp;/g, "&").replace(/<[^>]+>/g, "")
                       .replace(/\s+/g, " ").trim().toLowerCase();

const cmsWorks = dir("content/artworks").map(({ slug, data: d }) => ({
  slug,
  title: d.title ?? "",
  year: d.productionDate ? String(new Date(d.productionDate).getUTCFullYear()) : "",
  city: d.premiereCity ?? "",
  tagline: d.tagline ?? "",
  featured: !!d.featured,
  order: d.featureOrder ?? null,
  exhibitions: lines(d.exhibitions),
  acknowledgements: lines(d.acknowledgements),
  statement: paras(d.artistStatement),
  medium: d.medium ?? "", size: d.size ?? "", duration: d.duration ?? "",
}));
const cmsNews = dir("content/news").map(({ slug, data: d }) => ({
  slug, title: d.title ?? "",
  date: d.date ? new Date(d.date).toISOString().slice(0, 10) : "",
  city: d.city ?? "", eventType: d.eventType ?? "",
  statement: paras(d.statement), gallery: (d.gallery ?? []).length,
}));

// ── report ──────────────────────────────────────────────────────────────────────────────
const R = { same: 0, changed: [], onlyCms: [], onlyV6: [], missing: [] };
const bySlug = (a) => Object.fromEntries(a.map((x) => [x.slug, x]));
const V = bySlug(v6Works), C = bySlug(cmsWorks);

for (const slug of Object.keys(C)) if (!V[slug]) R.onlyCms.push(`artwork ${slug}`);
for (const slug of Object.keys(V)) if (!C[slug]) R.onlyV6.push(`artwork ${slug}`);

for (const slug of Object.keys(C)) {
  const c = C[slug], v = V[slug]; if (!v) continue;
  for (const f of ["title", "year", "city", "tagline"]) {
    if (norm(c[f]) === norm(v[f])) R.same++;
    else R.changed.push({ slug, field: f, v6: String(v[f] ?? ""), cms: String(c[f] ?? "") });
  }
  for (const f of ["exhibitions", "acknowledgements", "statement"]) {
    const cl = c[f] ?? [], vl = v[f] ?? [];
    const cv = cl.map(norm).join(" ¶ "), vv = vl.map(norm).join(" ¶ ");
    if (cv === vv) { R.same++; continue; }
    // Counts matching but text differing is the interesting case — v6's copy drifted.
    const kind = cl.length !== vl.length ? `${vl.length} -> ${cl.length} items`
                                         : `same count, text edited`;
    R.changed.push({ slug, field: f, v6: kind, cms: "",
                     detail: cl.length === vl.length
                       ? vl.map((x, i) => [norm(x), norm(cl[i] ?? "")])
                            .filter(([a, b]) => a !== b)
                            .slice(0, 2)
                            .map(([a, b]) => `      v6  ${a.slice(0, 66)}\n      cms ${b.slice(0, 66)}`)
                            .join("\n")
                       : "" });
  }
  // fields the CMS now has that v6 has no value for at all
  for (const f of ["medium", "size", "duration"])
    if (c[f] && !v[f]) R.missing.push({ slug, field: f, cms: c[f] });
}

const VN = bySlug(v6News.map((n) => ({ ...n, slug: n.slug ?? n.title })));
const line = (s) => console.log(s);
line("");
line("═══ ARTWORKS ═══════════════════════════════════════════════════════════════");
line(`  v6: ${v6Works.length}   CMS: ${cmsWorks.length}   fields identical: ${R.same}`);
if (R.onlyCms.length) line(`  ⊕ in CMS only : ${R.onlyCms.join(", ")}`);
if (R.onlyV6.length)  line(`  ⊖ in v6 only  : ${R.onlyV6.join(", ")}`);
line("");
line("  ── fields that DIFFER (expected: v6 is a 2026-08-06 snapshot) ──");
for (const c of R.changed) {
  line(`   ${c.slug.padEnd(16)} ${c.field.padEnd(16)} ${c.cms ? `v6="${c.v6}"  cms="${c.cms}"` : c.v6}`);
  if (c.detail) line(c.detail);
}
line("");
line(`  ── ${R.missing.length} values the CMS now has and v6 never showed ──`);
for (const m of R.missing.slice(0, 8))
  line(`   ${m.slug.padEnd(16)} ${m.field.padEnd(10)} ${String(m.cms).slice(0, 52)}`);
if (R.missing.length > 8) line(`   … and ${R.missing.length - 8} more`);
line("");
line("═══ NEWS ═══════════════════════════════════════════════════════════════════");
line(`  v6: ${v6News.length}   CMS: ${cmsNews.length}`);
// ⚠︎ Match on DATE, not title: four titles were edited in the CMS after the v6 snapshot,
// and matching on title reported all four as "new items" — a false positive worth avoiding.
const v6ByDate = new Map(v6News.map((n) => [n.date, n]));
const newItems = cmsNews.filter((n) => !v6ByDate.has(n.date));
line(`  ⊕ genuinely new : ${newItems.map((n) => n.slug).join(", ") || "none"}`);
const retitled = cmsNews
  .map((n) => [n, v6ByDate.get(n.date)])
  .filter(([n, v]) => v && norm(n.title) !== norm(v.title));
line("");
line(`  ── ${retitled.length} titles edited since the snapshot ──`);
for (const [n, v] of retitled) line(`   ${v.date}  "${v.title}"  ->  "${n.title}"`);
const stmt = cmsNews.filter((n) => n.statement.length).length;
const gal  = cmsNews.filter((n) => n.gallery).length;
line("");
line(`  statement : ${stmt}/${cmsNews.length} populated in CMS — v6 renders 0 (falls back to subheading)`);
line(`  gallery   : ${gal}/${cmsNews.length} populated in CMS — v6 renders 0`);
line("");
line("  ⚠︎ This is the largest content-to-site gap in the project, and it needs no");
line("     schema decisions — only the statement half needs no images either.");
line("");
