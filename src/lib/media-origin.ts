/**
 * media-origin.ts — the typed face of `media-origin.mjs`. The implementation lives in the
 * .mjs so `scripts/*.mjs` (plain node, no tsx) can import the SAME function the component
 * uses. See the header there for why that matters. Add logic there, types here.
 */
import {
  normaliseMediaUrl as _normaliseMediaUrl,
  looksLikeVideo as _looksLikeVideo,
  MEDIA_ORIGIN, TRANSFORM_HOST, MANIFEST_PATH,
} from "./media-origin.mjs";

export { MEDIA_ORIGIN, TRANSFORM_HOST, MANIFEST_PATH };

export type UrlVerdict =
  | { ok: true; url: string; note?: string }
  | { ok: false; url: string; reason: string };

/** One manifest entry. `lqip` arrives with BLUR; `bytes` is informational. */
export type MediaDims = { w: number; h: number; bytes?: number; lqip?: string };

export const normaliseMediaUrl: (raw: string | undefined | null) => UrlVerdict = _normaliseMediaUrl;
export const looksLikeVideo: (u: string) => boolean = _looksLikeVideo;
