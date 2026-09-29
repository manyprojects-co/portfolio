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
   * CSS MINIFIER — esbuild, NOT lightningcss (2026-09-29). Learned on the native-snap spike:
   * Astro 7's default (lightningcss 1.33) merged `animation-timeline` into the `animation`
   * shorthand and silently deleted every scroll-driven animation IN PRODUCTION ONLY. Nothing
   * on main uses animation-timeline today; this stays because the failure was invisible in
   * dev, same class as the `500ms → .5s` rewrite css-time.ts exists for, and esbuild's output
   * was verified clean by grepping dist/. ⛔ Re-grep the built CSS before switching back.
   */
  vite: { build: { cssMinify: "esbuild" } },
});
