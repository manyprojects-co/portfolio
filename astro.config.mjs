// @ts-check
import { defineConfig } from "astro/config";

/**
 * LOCKED (hooks.md § Decisions): static output, NO SSR adapter.
 * Deploy target is Cloudflare Workers Static Assets — NOT classic Pages, which has been in
 * maintenance mode since Apr 2025. Most tutorials still say "Pages"; translate accordingly.
 * Nothing here needs a Cloudflare adapter: `astro build` -> `dist` is the whole contract.
 */
export default defineConfig({
  site: "https://agawen.com",
  output: "static",
  outDir: "./dist",
  trailingSlash: "never",
  /**
   * 🐞 CSS MINIFIER — esbuild, NOT lightningcss (2026-09-25). Astro 7's default (lightningcss
   * 1.33) merges `animation-timeline: --card` INTO the `animation` shorthand, emitting
   * `animation: linear both card-stage --card`. The shorthand does not accept a timeline, so
   * the browser drops the whole declaration and every scroll-driven reveal silently vanishes
   * in production while working in dev. Same class as the `500ms → .5s` rewrite that
   * css-time.ts exists for: the build changes the CSS, and the change is invisible until it
   * isn't. Verified by grepping dist/_astro/global.*.css for `animation-timeline`.
   * ⛔ Do not remove without re-running that grep on the built output.
   */
  vite: { build: { cssMinify: "esbuild" } },
});
