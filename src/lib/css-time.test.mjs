/**
 * Pins the unit-aware CSS time parser. The bug this prevents: a production CSS minifier
 * rewriting `500ms` to `.5s` — same duration, different string — while a unit-naive
 * parseFloat turned every animation into a cut and the gesture arbiter's silence
 * threshold into 0.1ms. Found live on agawen.com, 2026-08-13.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCssTime } from "./css-time.ts";

describe("parseCssTime", () => {
  test("milliseconds, as authored", () => {
    assert.equal(parseCssTime("500ms", 0), 500);
    assert.equal(parseCssTime("100ms", 0), 100);
    assert.equal(parseCssTime("1200ms", 0), 1200);
  });

  test("⭐ seconds — the exact forms Astro's minifier emits", () => {
    assert.equal(parseCssTime(".5s", 0), 500,   "--dur 500ms minifies to .5s");
    assert.equal(parseCssTime("0.5s", 0), 500);
    assert.equal(parseCssTime(".1s", 0), 100,   "--gesture-gap 100ms minifies to .1s");
    assert.equal(parseCssTime("1.2s", 0), 1200, "--contact-copied-ms minifies to 1.2s");
    assert.equal(parseCssTime(".25s", 0), 250);
  });

  test("⚠︎ 'ms' must be tested before 's' — every ms value also ends in s", () => {
    assert.equal(parseCssTime("500ms", 0), 500, "not 500000");
  });

  test("unitless is treated as ms, matching v6", () => {
    assert.equal(parseCssTime("500", 0), 500);
    assert.equal(parseCssTime("0", 999), 0, "zero is a real value, not missing");
  });

  test("whitespace and case, as getPropertyValue can return them", () => {
    assert.equal(parseCssTime("  .5s  ", 0), 500);
    assert.equal(parseCssTime("500MS", 0), 500);
  });

  test("missing or unparseable falls back", () => {
    for (const bad of ["", "   ", null, undefined, "auto", "var(--x)"])
      assert.equal(parseCssTime(bad, 500), 500, `${JSON.stringify(bad)} -> fallback`);
  });

  test("the regression, stated as a value: no duration may collapse below 1ms", () => {
    // every time token the site reads, in both authored and minified form
    const pairs = [["500ms", ".5s"], ["100ms", ".1s"], ["1200ms", "1.2s"]];
    for (const [authored, minified] of pairs) {
      const a = parseCssTime(authored, 0), m = parseCssTime(minified, 0);
      assert.equal(a, m, `${authored} and ${minified} are the same duration`);
      assert.ok(a >= 1, `${authored} must not parse to a sub-millisecond value`);
    }
  });
});
