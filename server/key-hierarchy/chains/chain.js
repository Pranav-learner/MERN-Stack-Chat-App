/**
 * @module key-hierarchy/chains
 *
 * The **Chain** metadata model + pure helpers. A chain is a one-way symmetric key ratchet:
 * a device holds a *sending* chain and a *receiving* chain, each with its own chain key,
 * generation, index (ratchet position), version, and history. The two chains evolve
 * **independently**.
 *
 * @security The raw chain key NEVER appears in this record. It lives in
 * {@link module:key-hierarchy/keystore}; this module deals in PUBLIC metadata only. Each
 * chain index is a future per-message-key slot (Sprint 5) — advancing the chain moves the
 * index WITHOUT deriving a message key in this sprint.
 */

import { ChainStatus, ChainRole, INITIAL_INDEX } from "../types/types.js";
import { keyFingerprint, keyId } from "../derivation/derivation.js";
import { ChainRollbackError } from "../errors.js";

/**
 * Build a PUBLIC chain metadata record for a derived chain key at index 0.
 * @param {Buffer} chainKey the derived chain key (read for fingerprint/id; NOT stored)
 * @param {object} params
 * @param {string} params.direction one of {@link ChainDirection}
 * @param {string} params.role one of {@link ChainRole}
 * @param {number} [params.generation] @param {number} [params.version] @param {string} [params.at]
 * @returns {import("../types/types.js").ChainMeta}
 */
export function createChainMeta(chainKey, params) {
  const generation = params.generation ?? 0;
  const index = INITIAL_INDEX;
  const at = params.at ?? new Date().toISOString();
  return {
    chainId: keyId(chainKey, `${params.direction}:${generation}`, index),
    direction: params.direction,
    role: params.role,
    generation,
    index,
    version: params.version ?? 1,
    chainKeyId: keyId(chainKey, params.direction, index),
    fingerprint: keyFingerprint(chainKey),
    status: ChainStatus.ACTIVE,
    createdAt: at,
    history: [{ index, fingerprint: keyFingerprint(chainKey), at, reason: "created" }],
  };
}

/**
 * Produce the next chain metadata for an advance (index + 1). Pure — does not touch key
 * bytes; the caller supplies the newly-derived chain key for its fingerprint/id. Enforces
 * **rollback prevention** (index must strictly increase by one).
 * @param {import("../types/types.js").ChainMeta} chainMeta the current chain metadata
 * @param {Buffer} nextChainKey the newly-advanced chain key
 * @param {{ at?: string, reason?: string, maxHistory?: number }} [options]
 * @returns {import("../types/types.js").ChainMeta}
 * @throws {ChainRollbackError}
 */
export function advanceChainMeta(chainMeta, nextChainKey, options = {}) {
  const nextIndex = chainMeta.index + 1;
  if (nextIndex <= chainMeta.index) throw new ChainRollbackError("Chain index cannot move backwards", { details: { index: chainMeta.index } });
  const at = options.at ?? new Date().toISOString();
  const fingerprint = keyFingerprint(nextChainKey);
  const maxHistory = options.maxHistory ?? 500;
  const history = [...chainMeta.history, { index: nextIndex, fingerprint, at, reason: options.reason ?? "advanced" }];
  return {
    ...chainMeta,
    index: nextIndex,
    chainKeyId: keyId(nextChainKey, chainMeta.direction, nextIndex),
    fingerprint,
    history: history.length > maxHistory ? history.slice(history.length - maxHistory) : history,
  };
}

/** Mark a chain archived (a re-root superseded it). */
export function archiveChainMeta(chainMeta, at) {
  return { ...chainMeta, status: ChainStatus.ARCHIVED, archivedAt: at ?? new Date().toISOString() };
}

/** Whether a chain status still holds live key material. */
export function isChainLive(status) {
  return status === ChainStatus.ACTIVE;
}

export { ChainStatus, ChainRole };
