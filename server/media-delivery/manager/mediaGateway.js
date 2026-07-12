/**
 * @module media-delivery/manager/mediaGateway
 *
 * The **media gateway** — the storage-INDEPENDENT bridge from the delivery engine to the frozen Sprint-1
 * Secure Media Pipeline. It fetches a media object's OPAQUE ciphertext (once, cached with a TTL) through
 * the Sprint-1 {@link MediaManager} (which already verified integrity + is provider-agnostic) and slices
 * it into transport CHUNKS on demand, so the delivery engine can stream / progressively deliver ranges
 * WITHOUT knowing the storage provider or ever seeing a key.
 *
 * @security The gateway handles OPAQUE ciphertext ONLY. Each chunk carries a per-chunk SHA-256 so
 * integrity is preserved across the transport; the whole-object hash is still verified by Sprint 1. It
 * never decrypts.
 *
 * @performance Whole-object ciphertext is cached per media id for the session's lifetime (bounded TTL +
 * count), so N chunk reads = 1 storage fetch. Sprint 3 adds true range reads to the provider contract.
 */

import { sha256 } from "../../media/encryption/mediaEncryption.js";
import { MediaNotFoundError, MediaDeliveryError } from "../errors.js";
import { DEFAULT_CHUNK_SIZE, DEFAULT_SOURCE_CACHE_TTL_MS } from "../types/types.js";

/**
 * Build a media gateway over a Sprint-1 MediaManager. @param {object} mediaManager the Sprint-1 manager
 * @param {{ clock?: () => number, cacheTtlMs?: number, maxCached?: number }} [options]
 * @returns {object} the gateway
 */
export function createMediaGateway(mediaManager, options = {}) {
  const clock = options.clock ?? (() => Date.now());
  const ttl = options.cacheTtlMs ?? DEFAULT_SOURCE_CACHE_TTL_MS;
  const maxCached = options.maxCached ?? 32;
  const cache = new Map(); // mediaId → { ciphertext, encryption, expiresAt }

  const evict = () => {
    while (cache.size > maxCached) cache.delete(cache.keys().next().value);
  };

  return {
    /** Media metadata (control-plane; no blob). */
    async getMetadata(mediaId, actorId) {
      try {
        return await mediaManager.getMetadata({ mediaId, actorId });
      } catch (error) {
        if (error?.status === 404) throw new MediaNotFoundError("Media not found", { details: { mediaId } });
        throw error;
      }
    },

    /** Fetch the whole ciphertext (cached). @returns {Promise<{ ciphertext: Buffer, encryption: object }>} */
    async fetchCiphertext(mediaId, actorId) {
      const key = String(mediaId);
      const hit = cache.get(key);
      if (hit && hit.expiresAt > clock()) return { ciphertext: hit.ciphertext, encryption: hit.encryption };
      const dl = await mediaManager.downloadMedia({ mediaId, actorId });
      const ciphertext = Buffer.from(dl.ciphertext, "base64");
      const entry = { ciphertext, encryption: dl.encryption, expiresAt: clock() + ttl };
      cache.set(key, entry);
      evict();
      return { ciphertext, encryption: dl.encryption };
    },

    /**
     * Read one transport chunk of the ciphertext. @returns {Promise<{ index, offset, length, bytes: Buffer,
     * hash: string, last: boolean }>}
     */
    async readChunk(mediaId, actorId, { index, chunkSize = DEFAULT_CHUNK_SIZE }) {
      const { ciphertext } = await this.fetchCiphertext(mediaId, actorId);
      const chunkCount = Math.max(1, Math.ceil(ciphertext.length / chunkSize));
      if (index < 0 || index >= chunkCount) throw new MediaDeliveryError(`chunk index ${index} out of range [0,${chunkCount})`, { code: "ERR_MEDIA_DELIVERY_INVALID_RANGE", status: 416, reason: "invalid-range" });
      const offset = index * chunkSize;
      const bytes = ciphertext.subarray(offset, Math.min(ciphertext.length, offset + chunkSize));
      return { index, offset, length: bytes.length, bytes, hash: sha256(bytes), last: index === chunkCount - 1 };
    },

    /** The chunk layout for a media object (count + size) without reading bytes. */
    async chunkLayout(mediaId, actorId, chunkSize = DEFAULT_CHUNK_SIZE) {
      const media = await this.getMetadata(mediaId, actorId);
      const size = media.size ?? 0;
      return { size, chunkSize, chunkCount: Math.max(1, Math.ceil(size / chunkSize)), contentType: media.contentType };
    },

    /** Store an ASSEMBLED ciphertext (progressive upload completion) via the Sprint-1 pipeline. */
    async storeAssembled(params) {
      return mediaManager.uploadMedia(params);
    },

    /** Drop a cached source (e.g. on media deletion). */
    invalidate(mediaId) {
      cache.delete(String(mediaId));
    },
    _cacheSize() {
      return cache.size;
    },
  };
}
