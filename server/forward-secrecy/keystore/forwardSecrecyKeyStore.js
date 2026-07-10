/**
 * @module forward-secrecy/keystore
 *
 * Device-local secure store for the forward-secrecy **chain secret** and the **derived
 * per-generation keys**. This is the ONLY place these secrets live. Keyed by `sessionId`.
 *
 * Per session it holds:
 *   - `chainSecret` — the CURRENT chain secret (used to derive the NEXT generation);
 *   - `generations` — a `Map<generation, keys>` of recently-derived session keys, bounded
 *     by a retention window so superseded generations can still decrypt in-flight traffic;
 *   - `currentGeneration` — the generation used to encrypt NEW messages.
 *
 * @security Nothing here is ever serialized, persisted, logged, or returned by an API.
 * The repository + DTOs only ever see METADATA. Every mutation that drops a secret
 * zero-fills it first (via {@link module:forward-secrecy/destruction}). Construct one
 * store per device/process; it is transient by design.
 */

import { destroyGenerationKeys, destroyChainSecret, zeroize } from "../destruction/secureDestruction.js";
import { DestructionReason } from "../types/types.js";

/** In-memory device key vault for forward secrecy. */
export class ForwardSecrecyKeyStore {
  constructor() {
    /** @type {Map<string, { chainSecret: Buffer|null, currentGeneration: number, generations: Map<number, object>, context: object }>} */
    this._vault = new Map();
  }

  /**
   * Initialise a session's chain (generation 0). Overwrites+wipes any prior state.
   * @param {string} sessionId @param {Buffer} chainSecret @param {object} keys gen-0 {@link SessionKeys}
   * @param {object} context the session derivation context (kept device-local)
   */
  initialize(sessionId, chainSecret, keys, context) {
    this.destroySession(sessionId); // wipe anything stale first
    const generations = new Map();
    generations.set(0, keys);
    this._vault.set(String(sessionId), { chainSecret, currentGeneration: 0, generations, context });
  }

  /** Whether a session is initialised in this store. */
  has(sessionId) {
    return this._vault.has(String(sessionId));
  }

  /** The device-local derivation context stored for a session, or null. */
  getContext(sessionId) {
    return this._vault.get(String(sessionId))?.context ?? null;
  }

  /** The current chain secret (for deriving the next generation), or null. */
  getChainSecret(sessionId) {
    return this._vault.get(String(sessionId))?.chainSecret ?? null;
  }

  /** The current generation number, or `-1` if not initialised. */
  currentGeneration(sessionId) {
    return this._vault.get(String(sessionId))?.currentGeneration ?? -1;
  }

  /** The CURRENT generation's keys (for encrypting new messages), or null. */
  getCurrentKeys(sessionId) {
    const entry = this._vault.get(String(sessionId));
    return entry ? (entry.generations.get(entry.currentGeneration) ?? null) : null;
  }

  /** A specific generation's keys, or null (if never held or already destroyed). */
  getGenerationKeys(sessionId, generation) {
    return this._vault.get(String(sessionId))?.generations.get(generation) ?? null;
  }

  /** Find the keys whose PUBLIC `keyId` matches (used to decrypt by generation), or null. */
  findKeysByKeyId(sessionId, keyId) {
    const entry = this._vault.get(String(sessionId));
    if (!entry) return null;
    for (const keys of entry.generations.values()) {
      if (keys?.keyId === keyId) return keys;
    }
    return null;
  }

  /** The generation numbers currently held for a session (ascending). */
  heldGenerations(sessionId) {
    const entry = this._vault.get(String(sessionId));
    return entry ? [...entry.generations.keys()].sort((a, b) => a - b) : [];
  }

  /**
   * Commit a completed evolution: install the new chain secret + new keys and advance the
   * current pointer. The PREVIOUS chain secret is securely destroyed (this is the core
   * forward-secrecy step). Returns the previous chain's destruction record.
   * @param {string} sessionId @param {Buffer} nextChainSecret @param {number} nextGeneration @param {object} nextKeys
   * @param {{ at?: string }} [meta]
   * @returns {import("../types/types.js").DestructionRecord}
   */
  commitEvolution(sessionId, nextChainSecret, nextGeneration, nextKeys, meta = {}) {
    const entry = this._vault.get(String(sessionId));
    if (!entry) throw new Error("Cannot commit evolution for an uninitialised session");
    const previousGeneration = entry.currentGeneration;
    // 1. Destroy the previous chain secret — one-way past this point.
    const destruction = destroyChainSecret(entry.chainSecret, {
      generation: previousGeneration,
      reason: DestructionReason.SUPERSEDED,
      at: meta.at,
    });
    // 2. Install the new secret + keys and advance.
    entry.chainSecret = nextChainSecret;
    entry.generations.set(nextGeneration, nextKeys);
    entry.currentGeneration = nextGeneration;
    return destruction;
  }

  /**
   * Prune generations strictly older than `minGeneration`, securely destroying their
   * derived keys. Returns the destruction records.
   * @param {string} sessionId @param {number} minGeneration @param {{ at?: string, reason?: string }} [meta]
   * @returns {import("../types/types.js").DestructionRecord[]}
   */
  pruneOlderThan(sessionId, minGeneration, meta = {}) {
    const entry = this._vault.get(String(sessionId));
    if (!entry) return [];
    const records = [];
    for (const gen of [...entry.generations.keys()]) {
      if (gen < minGeneration) {
        const keys = entry.generations.get(gen);
        records.push(destroyGenerationKeys(keys, { generation: gen, reason: meta.reason ?? DestructionReason.RETENTION_EXPIRED, at: meta.at }));
        entry.generations.delete(gen);
      }
    }
    return records;
  }

  /** Securely destroy ALL of a session's key material. Idempotent. @returns {boolean} */
  destroySession(sessionId) {
    const entry = this._vault.get(String(sessionId));
    if (!entry) return false;
    for (const keys of entry.generations.values()) destroyGenerationKeys(keys, { generation: -1, reason: DestructionReason.SESSION_ENDED });
    zeroize(entry.chainSecret);
    entry.generations.clear();
    this._vault.delete(String(sessionId));
    return true;
  }

  /** Number of sessions with key material held. */
  get size() {
    return this._vault.size;
  }

  /** Destroy all key material (e.g. on logout). */
  destroyAll() {
    for (const id of [...this._vault.keys()]) this.destroySession(id);
  }
}
