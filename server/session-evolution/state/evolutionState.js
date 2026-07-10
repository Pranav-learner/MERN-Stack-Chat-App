/**
 * @module session-evolution/state
 *
 * The **Evolution State Model** — the record factory + pure helpers for an evolution
 * sidecar. An evolution record binds a {@link module:shs/session} Secure Session id to
 * a generation timeline, an evolution lifecycle state, attached policies, a pending
 * schedule slot, and the metadata framework blocks.
 *
 * @security This record is a PUBLIC metadata sidecar. It carries no raw key bytes, no
 * shared secrets, and no ratchet state — only generation NUMBERS and key-version
 * POINTERS (integers). It is additive: it never modifies the Secure Session schema.
 * Sprint 1 performs NO cryptography.
 */

import crypto from "node:crypto";
import {
  EvolutionState,
  EVOLUTION_SCHEMA_VERSION,
  INITIAL_GENERATION,
} from "../types/types.js";
import {
  createEvolutionMetadata,
  createPolicyMetadata,
  createSecurityMetadata,
  createRatchetMetadata,
  createChainMetadata,
  createMessageMetadata,
} from "../metadata/metadata.js";

/**
 * Build an evolution record in the {@link EvolutionState.INITIALIZED} state.
 *
 * @param {object} params
 * @param {string} params.sessionId the Secure Session this evolution tracks
 * @param {string} [params.handshakeId] the originating handshake (for lineage)
 * @param {number} [params.generation=0] starting generation
 * @param {import("../types/types.js").PolicyDescriptor[]} [params.policies] attached policies
 * @param {object} [params.metadata] free-form metadata
 * @param {string} [params.evolutionId] override id (else generated)
 * @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @returns {import("../types/types.js").EvolutionRecord}
 */
export function createEvolutionRecord(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowIso = new Date(clock()).toISOString();
  const generation = params.generation ?? INITIAL_GENERATION;
  const policies = (params.policies ?? []).map((p) => ({ ...p }));
  const keyVersion = { current: generation, previous: null, next: null };

  return {
    evolutionId: params.evolutionId ?? idGenerator(),
    sessionId: String(params.sessionId),
    handshakeId: params.handshakeId ? String(params.handshakeId) : undefined,
    state: EvolutionState.INITIALIZED,
    generation,
    keyVersion,
    versionHistory: [],
    policies,
    pending: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    lastEvolutionAt: null,
    evolutionMetadata: createEvolutionMetadata({ generation, keyVersion }),
    policyMetadata: createPolicyMetadata(policies, { at: policies.length ? nowIso : null }),
    securityMetadata: createSecurityMetadata(),
    audit: [],
    // FUTURE placeholders — inert until later Layer 5 sprints populate them.
    ratchetMetadata: createRatchetMetadata(),
    chainMetadata: createChainMetadata(),
    messageMetadata: createMessageMetadata(),
    metadata: params.metadata ?? {},
    history: [{ from: null, to: EvolutionState.INITIALIZED, at: nowIso }],
    schemaVersion: EVOLUTION_SCHEMA_VERSION,
  };
}

/** Whether an evolution record is retired (terminal). */
export function isEvolutionRetired(record) {
  return record?.state === EvolutionState.RETIRED;
}

/** Whether an evolution record currently has a queued (scheduled/pending) evolution. */
export function hasPendingEvolution(record) {
  return Boolean(record?.pending);
}

/**
 * Compute the next generation + key-version pointers for an advance, WITHOUT mutating
 * the record and WITHOUT generating any keys.
 * @param {import("../types/types.js").EvolutionRecord} record
 * @returns {{ generation: number, keyVersion: import("../types/types.js").KeyVersion }}
 */
export function projectNextGeneration(record) {
  const generation = (record.generation ?? INITIAL_GENERATION) + 1;
  return {
    generation,
    keyVersion: {
      current: generation,
      previous: record.keyVersion?.current ?? record.generation ?? INITIAL_GENERATION,
      next: null,
    },
  };
}
