/**
 * format.ts — display formatting, lifted verbatim from prototype-v6.html.
 * Pure functions, no DOM, so the panels can render these at BUILD time instead of
 * in the browser. `timeElapsed` is the one exception — see the note on it.
 */

const SMALL = new Set(["a","an","and","as","at","but","by","for","in","of","on","or","the","to","vs","with"]);

/** Title-case that preserves acronyms (EMERGE:NCY, BEAM) and lowercases small words. */
export const titleCase = (s: string): string =>
  s.split(/\s+/).map((w, i, arr) => {
    if (w.length > 1 && /[A-Z]/.test(w) && w === w.toUpperCase()) return w;  // keep acronyms
    const lw = w.toLowerCase();
    if (i !== 0 && i !== arr.length - 1 && SMALL.has(lw)) return lw;
    return lw.charAt(0).toUpperCase() + lw.slice(1);
  }).join(" ");

export const TYPE_LABELS: Record<string, string> = {
  "Group exhibition": "Exhibition",
  "Solo exhibition": "Solo Exhibition",
  "Artist Talk": "Talk",
};
export const typeLabel = (t?: string | null): string => (t ? TYPE_LABELS[t] ?? t : "");

/**
 * ⚠︎ RELATIVE TO *NOW*, so it cannot be fully baked at build time — a static page built
 * in August would still say "3d" in December. Rendered at build for the initial paint
 * (so no-JS and first paint are correct) and refreshed on load by site.js.
 * `now` is injectable so tests and the client refresh share one implementation.
 */
export function timeElapsed(date: Date | string, now: Date = new Date()): string {
  const then = typeof date === "string" ? new Date(date + "T00:00:00") : date;
  const days = Math.floor((now.getTime() - then.getTime()) / 86400000);
  let months = (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
  if (now.getDate() < then.getDate()) months -= 1;
  if (days < 0) return String(then.getFullYear());
  if (months >= 6) return String(then.getFullYear());
  if (days < 1) return "today";
  if (days < 7) return `${days}d`;
  if (days < 28) return `${Math.floor(days / 7)}w`;
  return `${Math.max(1, months)}m`;
}

/** The two inline markdown forms Pages CMS actually emits in these fields. */
export const inlineMd = (s: string): string =>
  s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
   .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

/**
 * One list row rendered as: grey year, then the rest. Shared by the bio lists and the
 * artwork exhibitions so the two cannot drift apart visually — they now produce byte-
 * identical markup and differ ONLY in how the year is found.
 */
const yearItem = (year: string, rest: string): string =>
  `<div class="about-item"><span class="yr">${year}</span> ${inlineMd(rest.trim())}</div>`;

const plainItem = (line: string): string =>
  `<div class="about-item">${inlineMd(line.trim())}</div>`;

/**
 * An ARTWORK exhibitions row. ⚠︎ THE YEAR IS TYPED LAST AND RENDERS FIRST.
 *   stored:    "CIRCA2023, London, Milan, and Berlin, 2023"
 *   rendered:  "2023 CIRCA2023, London, Milan, and Berlin"
 * So this is a reorder, not just a restyle — the bio list stores the year leading and the
 * artwork files store it trailing, and JJ wants both to READ the same (2026-08-23).
 *
 * ⚠︎ The match is non-greedy on the head and anchored on the tail, which is what keeps
 * "CIRCA2023" intact: a greedy or unanchored year match would find the 2023 inside the
 * title. Verified against all 10 populated exhibitions rows, including that one and a
 * "2024 - 2026" range. A row with no trailing year renders whole and untouched rather
 * than disappearing.
 */
export function exhibitionItem(line: string): string {
  const m = line.match(/^(.*?),\s*((?:\d{4})(?:\s*[–—-]\s*\d{4})?)\s*$/);
  return m ? yearItem(m[2], m[1]) : plainItem(line);
}

/** A bio list row: "2025 - Thing" splits the year into its own span. */
export function aboutItem(line: string): string {
  const m = line.match(/^\s*(\d{4})\s*-\s*(.*)$/);
  return m ? yearItem(m[1], m[2]) : plainItem(line);
}

/**
 * News dates, long form: "August 15, 2026".
 *
 * ⚠︎ UTC EXPLICITLY, EVERY TIME. `new Date("2023-09-06")` parses as UTC midnight, and
 * formatting that in any timezone behind UTC prints the 5th. The site is authored in
 * Manila (UTC+8) and read anywhere, so a local-time format would show different dates to
 * different visitors. `map.ts` already takes this care with getUTCFullYear(); same rule.
 *
 * ⚠︎ NEWS DATES ARE DAY-PRECISE, ARTWORK DATES ARE NOT. All 15 news `date` values carry a
 * real day (not one is day-01); all 11 artwork `productionDate` values are day-01, i.e.
 * month precision. So the day is always shown here and never for an artwork year.
 * ⛔ AND "SHOW THE DAY IF PRESENT" CANNOT BE IMPLEMENTED — an ISO date cannot distinguish
 * "the 1st" from "no day given". A heuristic that hid the day on the 1st would silently
 * drop it for a genuine first-of-the-month event. Always show it.
 */
const D = (d: Date, opts: Intl.DateTimeFormatOptions) =>
  d.toLocaleDateString("en-US", { timeZone: "UTC", ...opts });

const MONTH_DAY = { month: "long", day: "numeric" } as const;
const FULL = { month: "long", day: "numeric", year: "numeric" } as const;

export const longDate = (d: Date): string => D(d, FULL);

/**
 * A date range with the repetition collapsed. Writing both ends out in full gives
 * "November 28, 2023 – December 5, 2023", which repeats the year, and within one month it
 * repeats the month too. Every real range in the content today is short, so the redundancy
 * is the common case rather than the edge one.
 *
 *   same month  ->  September 6–10, 2023        (tight dash: it reads as one span)
 *   same year   ->  November 28 – December 5, 2023
 *   crosses years ->  December 28, 2025 – January 4, 2026
 */
export function dateRange(start: Date, end: Date): string {
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const sameMonth = sameYear && start.getUTCMonth() === end.getUTCMonth();
  if (sameMonth) return `${D(start, MONTH_DAY)}–${D(end, { day: "numeric" })}, ${end.getUTCFullYear()}`;
  if (sameYear) return `${D(start, MONTH_DAY)} – ${D(end, MONTH_DAY)}, ${end.getUTCFullYear()}`;
  return `${D(start, FULL)} – ${D(end, FULL)}`;
}
