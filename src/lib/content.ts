/**
 * content.ts — the one place collections are read and mapped. Every route imports from
 * here so "what is a work" is answered identically on `/`, `/art/[slug]`, and the partial.
 */
import { getCollection, getEntry } from "astro:content";
import { mapWork, mapNews, featuredWorks, newsNewestFirst } from "./map";

export const allWorks = async () => (await getCollection("artworks")).map(mapWork);
export const allNews = async () => newsNewestFirst((await getCollection("news")).map(mapNews));
export const aboutData = async () => (await getEntry("about", "about"))!.data;
export const contactData = async () => (await getEntry("contact", "contact"))!.data;

/** Landing carousel: featured only, by featureOrder. */
export const featured = featuredWorks;

/**
 * Grid order: featured first by featureOrder, then the rest alphabetically.
 * v6 sorted on a synthetic `order: 999`; the schema has no order for unfeatured works,
 * so the tiebreak is explicit rather than accidental.
 */
export const gridOrder = (works: any[]) =>
  [...works].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.title.localeCompare(b.title));
