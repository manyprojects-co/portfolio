/**
 * css-time.ts — parse a CSS <time> value into milliseconds.
 *
 * ⚠︎ WHY THIS EXISTS. v6 read every time token with a bare
 * `parseFloat(getComputedStyle(root).getPropertyValue(name))`, which is unit-NAIVE: it
 * takes the number and throws the unit away. That worked for two years because nothing
 * ever rewrote the CSS — the prototypes are single files opened from disk, so `500ms`
 * reached the browser as the literal string `500ms` and parseFloat gave 500.
 *
 * The Astro port introduced a production CSS minifier, and a minifier is entitled to
 * rewrite any value to an equivalent shorter one. `500ms` and `0.5s` are the same
 * duration, and `.5s` is four bytes shorter — so the built CSS says `.5s`, parseFloat
 * returns 0.5, and every duration in the site becomes HALF A MILLISECOND.
 *
 * What that actually broke on the live site (2026-08-13, found by JJ):
 *   --dur               500ms -> .5s   every lerp completes instantly — a CUT, not a tween
 *   --tab-dur           500ms -> .5s   tab snapping likewise
 *   --contact-copied-ms 1200ms -> 1.2s "Copied!" flashes for 1.2ms — invisible
 *   --gesture-gap       100ms -> .1s   ⭐ THE DANGEROUS ONE. This is the arbiter's silence
 *                                      threshold. At 0.1ms EVERY wheel event satisfies
 *                                      dt > gap, so every event mints a fresh gesture with
 *                                      a fresh budget — "one gesture = one lerp" is gone,
 *                                      and the card->landing double-hop that took eight
 *                                      rounds to kill is live again. Nothing looks broken
 *                                      until a flick occasionally jumps two screens.
 *
 * The lesson worth keeping: a value that is CORRECT in CSS can still be a different
 * STRING than the one you wrote, so never parse a CSS value by assuming its unit.
 */

/** Parse a CSS <time> ("500ms", "0.5s", ".5s", "500") to milliseconds. */
export function parseCssTime(raw: string | null | undefined, fallback: number): number {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return fallback;
  // ⚠︎ order matters: "500ms" ends with BOTH "ms" and "s". Test ms first.
  if (/ms$/i.test(s)) return n;
  if (/s$/i.test(s)) return n * 1000;
  return n;                                   // unitless — v6 treated bare numbers as ms
}
