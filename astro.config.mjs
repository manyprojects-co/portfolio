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
});
