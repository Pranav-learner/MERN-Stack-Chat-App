/**
 * @module media/providers/inMemoryStorageProvider
 *
 * In-memory storage provider for encrypted media blobs (tests & ephemeral execution).
 */

export function createInMemoryStorageProvider() {
  const store = new Map();

  return {
    async store(mediaId, blob) {
      const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
      store.set(String(mediaId), buffer);
      return { mediaId: String(mediaId), size: buffer.length };
    },

    async retrieve(mediaId) {
      const blob = store.get(String(mediaId));
      if (!blob) return null;
      return blob;
    },

    async delete(mediaId) {
      return store.delete(String(mediaId));
    },

    async has(mediaId) {
      return store.has(String(mediaId));
    },

    clear() {
      store.clear();
    },
  };
}
