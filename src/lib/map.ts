/**
 * map.ts — THE NAMING BRIDGE. The CMS and the prototype disagree about names, and
 * `hooks.md § Naming: front-end ↔ schema` has carried that as an open question since
 * 2026-08-06. This module answers it by ISOLATION rather than by renaming either side:
 * the CMS keeps the names Xin edits, the design keeps the names it was built with, and
 * every translation happens exactly here.
 *
 *   prototype        CMS                 note
 *   ---------        ---                 ----
 *   city             premiereCity        renamed in research-notes §6, never applied in the repo
 *   order            featureOrder        prototype used a synthetic 999 for unfeatured; dropped
 *   year             productionDate      was `number`, now a `date` (month precision)
 *   statement[]      artistStatement     array of paragraphs vs one rich-text blob
 *   image/gallery    …Visual objects     one image per work vs three surface-specific slots
 *
 * ⚠︎ NOTHING ELSE MAY DO THIS. If a component reaches for `premiereCity`, the bridge has
 * leaked and the question is open again.
 */
import type { CollectionEntry } from "astro:content";

/** A gallery row is either a legacy path string or a (possibly empty) new-shape object. */
export type Media = { kind: "image" | "video"; src: string; caption?: string } | null;

/**
 * Normalise ONE visual slot to a single shape, or null.
 * Empty is the expected case today: every visual field is unpopulated in every file, so
 * this returns null for essentially all real content. Callers must render an empty state,
 * not assume a src. See `content.config.ts` note 1.
 */
export function media(v: unknown): Media {
  if (!v) return null;
  if (typeof v === "string") {
    // legacy flat path (`/assets/…`). ⚠︎ That origin was DELETED on 2026-08-10 — these
    // resolve to nothing. Carried through so the report can count them, not because they work.
    return v.trim() ? { kind: "image", src: v.trim() } : null;
  }
  const o = v as Record<string, unknown>;
  const img = typeof o.imageUrl === "string" ? o.imageUrl.trim() : "";
  const vid = typeof o.videoUrl === "string" ? o.videoUrl.trim() : "";
  const caption = typeof o.caption === "string" && o.caption.trim() ? o.caption.trim() : undefined;
  if (o.mediaType === "video" && vid) return { kind: "video", src: vid, caption };
  if (img) return { kind: "image", src: img, caption };
  if (vid) return { kind: "video", src: vid, caption };
  return null; // a row that exists but carries no URL — Xin has created several
}

/** Normalise a gallery, dropping rows that carry nothing. */
export const mediaList = (list: unknown): NonNullable<Media>[] =>
  Array.isArray(list) ? list.map(media).filter((m): m is NonNullable<Media> => m !== null) : [];

/**
 * Rich-text (one markdown blob) -> the array of paragraphs the prototype renders.
 * Splits on blank lines, which is how Pages CMS writes paragraph breaks. Trailing
 * two-space hard breaks are preserved as separate lines within a paragraph.
 */
export const paragraphs = (s?: string): string[] =>
  !s ? [] : s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/** Rich-text -> one line per row, for the list-shaped fields (exhibitions, bio sections). */
export const lines = (s?: string): string[] =>
  !s ? [] : s.split("\n").map((l) => l.replace(/\s+$/, "").trim()).filter(Boolean);

export function mapWork(e: CollectionEntry<"artworks">) {
  const d = e.data;
  return {
    slug: e.id,
    title: d.title,
    /** ⚠︎ derived, not stored. `productionDate` is month-precision; a work spanning years
     *  (personhood shows "2024 - 2026" in v6) CANNOT be expressed — see the open item. */
    year: d.productionDate ? String(d.productionDate.getUTCFullYear()) : "",
    productionDate: d.productionDate ?? null,
    tagline: d.tagline ?? "",
    city: d.premiereCity ?? "",            // ← the rename that was decided but never applied
    medium: d.medium ?? "",
    size: d.size ?? "",
    duration: d.duration ?? "",
    featured: d.featured,
    order: d.featureOrder ?? null,         // ← no synthetic 999; `featured` is the filter
    exhibitions: lines(d.exhibitions),
    acknowledgements: lines(d.acknowledgements),
    statement: paragraphs(d.artistStatement),
    technical: {
      tagline: d.technicalTagline ?? "",
      text: paragraphs(d.technicalText),
      gallery: mediaList(d.technicalGallery),
    },
    visuals: {
      landing: media(d.landingVisual),     // landing carousel
      tabArt: media(d.tabArtVisual),       // ART grid (site-specific)
      cardCover: media(d.cardCoverVisual), // detail hero (16:9)
    },
    gallery: mediaList(d.cardGallery),
  };
}

export function mapNews(e: CollectionEntry<"news">) {
  const d = e.data;
  return {
    slug: e.id,
    title: d.title,
    subheading: d.subheading ?? "",
    date: d.date ?? null,
    endDate: d.endDate ?? null,
    isDateRange: d.isDateRange,
    location: d.location ?? "",            // 15/15 populated, renders nowhere yet
    city: d.city ?? "",
    eventType: d.eventType ?? null,
    statement: paragraphs(d.statement),    // 13/15 populated, renders nowhere yet
    // main visual: new-shape slot first, legacy flat `image` only as a fallback
    image: media(d.mainVisual) ?? media(d.image),
    gallery: mediaList(d.gallery),
  };
}

/** Landing carousel: featured only, by featureOrder. */
export const featuredWorks = <T extends { featured: boolean; order: number | null }>(w: T[]) =>
  w.filter((x) => x.featured).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));

/** News list: reverse-chronological on start date (DECIDED 2026-08-06; no CMS field for it). */
export const newsNewestFirst = <T extends { date: Date | null }>(n: T[]) =>
  [...n].sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
