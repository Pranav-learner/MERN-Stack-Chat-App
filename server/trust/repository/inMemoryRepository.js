/**
 * @module trust/repository/inMemory
 *
 * In-memory trust repositories (verifications + identity-change log) for tests and
 * as the reference for the repository contract. Records are deep-copied.
 *
 * ## Contract (shared with the Mongo implementation)
 * `verifications`:
 * - `create(record) -> record`
 * - `findByPair(verifierUser, subjectUser) -> record | null`
 * - `findById(verificationId) -> record | null`
 * - `findByVerifier(verifierUser) -> record[]`
 * - `findBySubject(subjectUser) -> record[]`
 * - `update(verificationId, patch) -> record`
 * - `delete(verificationId) -> boolean`
 *
 * `changes`:
 * - `create(record) -> record`
 * - `findBySubject(subjectUser) -> record[]`
 */

import { VerificationNotFoundError } from "../errors.js";

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const pairKey = (a, b) => `${String(a)}::${String(b)}`;

/** @returns {{ verifications: object, changes: object, reset: () => void }} */
export function createInMemoryTrustRepositories() {
  /** @type {Map<string, object>} verificationId -> record */
  const byId = new Map();
  /** @type {Map<string, string>} pairKey -> verificationId */
  const byPair = new Map();
  /** @type {object[]} */
  const changeLog = [];

  const verifications = {
    async create(record) {
      byId.set(record.verificationId, clone(record));
      byPair.set(pairKey(record.verifierUser, record.subjectUser), record.verificationId);
      return clone(record);
    },
    async findByPair(verifierUser, subjectUser) {
      const id = byPair.get(pairKey(verifierUser, subjectUser));
      return id ? clone(byId.get(id)) : null;
    },
    async findById(verificationId) {
      return byId.has(verificationId) ? clone(byId.get(verificationId)) : null;
    },
    async findByVerifier(verifierUser) {
      return [...byId.values()].filter((r) => String(r.verifierUser) === String(verifierUser)).map(clone);
    },
    async findBySubject(subjectUser) {
      return [...byId.values()].filter((r) => String(r.subjectUser) === String(subjectUser)).map(clone);
    },
    async update(verificationId, patch) {
      const existing = byId.get(verificationId);
      if (!existing) throw new VerificationNotFoundError("Verification not found", { details: { verificationId } });
      const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      byId.set(verificationId, clone(updated));
      return clone(updated);
    },
    async delete(verificationId) {
      const existing = byId.get(verificationId);
      if (!existing) return false;
      byId.delete(verificationId);
      byPair.delete(pairKey(existing.verifierUser, existing.subjectUser));
      return true;
    },
  };

  const changes = {
    async create(record) {
      changeLog.push(clone(record));
      return clone(record);
    },
    async findBySubject(subjectUser) {
      return changeLog.filter((c) => String(c.subjectUser) === String(subjectUser)).map(clone);
    },
  };

  return {
    verifications,
    changes,
    reset: () => {
      byId.clear();
      byPair.clear();
      changeLog.length = 0;
    },
  };
}
