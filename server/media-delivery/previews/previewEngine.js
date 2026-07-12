/**
 * @module media-delivery/previews
 *
 * **Preview engine** — ASYNC, PLUGGABLE preview generation for non-image media (document previews, video
 * poster frames, audio artwork) + a small TTL PREVIEW CACHE. It shares the thumbnail engine's record
 * model + generation lifecycle (the two differ only by KIND + generator), and adds a document-preview
 * metadata shape (page count / first-page descriptor) + an audio-artwork placeholder.
 *
 * @security Preview records + cache entries carry metadata ONLY — never plaintext content or keys. A
 * generated preview, if produced, is itself encrypted media via the Sprint-1 pipeline.
 *
 * @evolution Generation is async + pluggable; the default generator is a deterministic metadata-only
 * placeholder (no codecs). The delivery engine owns persistence + events; this module owns the preview-
 * specific helpers + the cache.
 */

import crypto from "node:crypto";
import { PreviewKind, DEFAULT_PREVIEW_CACHE_TTL_MS } from "../types/types.js";

/**
 * The default METADATA-ONLY preview generator (no codecs). Deterministic. Shapes the metadata per kind:
 * document → { pages, firstPage }, audio → { artwork placeholder }, video → { poster }.
 * @returns {Promise<{ metadata: object }>}
 */
export async function defaultPreviewGenerator({ media, kind }) {
  const base = crypto.createHash("sha256").update(`${media?.mediaId}|${kind}`).digest("hex").slice(0, 24);
  switch (kind) {
    case PreviewKind.DOCUMENT_PREVIEW:
      return { metadata: { pages: media?.metadata?.pages ?? 1, firstPage: base, format: "webp", generatedBy: "default-preview-generator" } };
    case PreviewKind.AUDIO_ARTWORK:
      return { metadata: { artwork: base, placeholder: true, format: "webp", generatedBy: "default-preview-generator" } };
    case PreviewKind.VIDEO_THUMBNAIL:
      return { metadata: { poster: base, atMs: 0, format: "webp", generatedBy: "default-preview-generator" } };
    default:
      return { metadata: { descriptor: base, format: "webp", generatedBy: "default-preview-generator" } };
  }
}

/** A small TTL cache of READY previews keyed by `${mediaId}:${kind}`. */
export class PreviewCache {
  /** @param {{ ttlMs?: number, max?: number, clock?: () => number }} [options] */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PREVIEW_CACHE_TTL_MS;
    this.max = options.max ?? 5000;
    this.clock = options.clock ?? (() => Date.now());
    this._map = new Map();
    this._stats = { hits: 0, misses: 0, sets: 0, evictions: 0 };
  }

  _key(mediaId, kind) {
    return `${mediaId}:${kind}`;
  }

  get(mediaId, kind) {
    const k = this._key(mediaId, kind);
    const e = this._map.get(k);
    if (e && e.expiresAt > this.clock()) {
      this._map.delete(k);
      this._map.set(k, e);
      this._stats.hits++;
      return e.value;
    }
    if (e) this._map.delete(k);
    this._stats.misses++;
    return null;
  }

  set(mediaId, kind, value) {
    const k = this._key(mediaId, kind);
    if (this._map.has(k)) this._map.delete(k);
    this._map.set(k, { value, expiresAt: this.clock() + this.ttlMs });
    this._stats.sets++;
    while (this._map.size > this.max) {
      this._map.delete(this._map.keys().next().value);
      this._stats.evictions++;
    }
    return value;
  }

  invalidate(mediaId, kind) {
    if (kind) this._map.delete(this._key(mediaId, kind));
    else for (const k of [...this._map.keys()]) if (k.startsWith(`${mediaId}:`)) this._map.delete(k);
  }

  stats() {
    const total = this._stats.hits + this._stats.misses;
    return { ...this._stats, size: this._map.size, hitRate: total ? Number((this._stats.hits / total).toFixed(4)) : 0 };
  }
}

export { PreviewKind };
