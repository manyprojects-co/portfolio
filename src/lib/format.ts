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

/** A bio list row: "2025 - Thing" splits the year into its own span. */
export function aboutItem(line: string): string {
  const m = line.match(/^\s*(\d{4})\s*-\s*(.*)$/);
  if (!m) return `<div class="about-item">${inlineMd(line.trim())}</div>`;
  return `<div class="about-item"><span class="yr">${m[1]}</span> ${inlineMd(m[2].trim())}</div>`;
}
