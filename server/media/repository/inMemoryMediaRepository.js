/**
 * @module media/repository/inMemoryMediaRepository
 *
 * In-memory repository for media metadata, operations, and integrity reports.
 */

export function createInMemoryMediaRepository() {
  const mediaStore = new Map();
  const operationStore = new Map();
  const integrityStore = new Map();

  return {
    mediaRepo: {
      async create(doc) {
        const copy = { ...doc, createdAt: doc.createdAt ?? Date.now(), updatedAt: doc.updatedAt ?? Date.now() };
        mediaStore.set(String(copy.mediaId), copy);
        return { ...copy };
      },

      async findById(mediaId) {
        const hit = mediaStore.get(String(mediaId));
        return hit ? { ...hit } : null;
      },

      async update(mediaId, updates) {
        const existing = mediaStore.get(String(mediaId));
        if (!existing) return null;
        const updated = { ...existing, ...updates, updatedAt: Date.now() };
        mediaStore.set(String(mediaId), updated);
        return { ...updated };
      },

      async delete(mediaId) {
        return mediaStore.delete(String(mediaId));
      },

      async list({ ownerId, state, limit = 50 } = {}) {
        let results = Array.from(mediaStore.values());
        if (ownerId) results = results.filter((m) => m.ownerId === ownerId);
        if (state) results = results.filter((m) => m.state === state);
        return results.slice(0, limit).map((m) => ({ ...m }));
      },

      async count() {
        return mediaStore.size;
      },
    },

    operationRepo: {
      async create(doc) {
        const copy = { ...doc, createdAt: doc.createdAt ?? Date.now(), updatedAt: doc.updatedAt ?? Date.now() };
        operationStore.set(String(copy.operationId), copy);
        return { ...copy };
      },

      async findById(operationId) {
        const hit = operationStore.get(String(operationId));
        return hit ? { ...hit } : null;
      },

      async update(operationId, updates) {
        const existing = operationStore.get(String(operationId));
        if (!existing) return null;
        const updated = { ...existing, ...updates, updatedAt: Date.now() };
        operationStore.set(String(operationId), updated);
        return { ...updated };
      },

      async list({ mediaId, type, limit = 50 } = {}) {
        let results = Array.from(operationStore.values());
        if (mediaId) results = results.filter((o) => o.mediaId === mediaId);
        if (type) results = results.filter((o) => o.type === type);
        return results.slice(0, limit).map((o) => ({ ...o }));
      },

      async count() {
        return operationStore.size;
      },
    },

    integrityRepo: {
      async create(doc) {
        const copy = { ...doc, verifiedAt: doc.verifiedAt ?? Date.now() };
        integrityStore.set(String(copy.mediaId), copy);
        return { ...copy };
      },

      async findById(mediaId) {
        const hit = integrityStore.get(String(mediaId));
        return hit ? { ...hit } : null;
      },
    },
  };
}
