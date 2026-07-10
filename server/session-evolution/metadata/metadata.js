/**
 * @module session-evolution/metadata
 *
 * The **Metadata Framework** for evolution records. Evolution state is described by
 * several independent, composable metadata blocks so future sprints can extend any one
 * of them without touching the core record:
 *
 * - **evolutionMetadata** — generation, key-version pointers, counts, last-evolution.
 * - **policyMetadata** — how many policies are attached, of which types, last update.
 * - **securityMetadata** — which cryptographic guarantees are active (all `false` in
 *   Sprint 1: no forward secrecy, no ratcheting, no post-compromise security yet).
 * - **audit** — an append-only trail of notable evolution actions.
 * - **ratchetMetadata / chainMetadata / messageMetadata** — FUTURE placeholders that
 *   later Layer 5 sprints (Double Ratchet, Chain Keys, Message Keys) populate.
 *
 * @security Metadata blocks hold PUBLIC descriptors and counters ONLY — never key
 * bytes, shared secrets, or ratchet secrets. This sprint performs NO cryptography.
 */

import { EVOLUTION_FRAMEWORK, EVOLUTION_SCHEMA_VERSION, INITIAL_GENERATION } from "../types/types.js";

/**
 * Build the evolution metadata block.
 * @param {{ generation?: number, keyVersion?: import("../types/types.js").KeyVersion, evolutionCount?: number, lastEvolutionAt?: string|null }} [init]
 * @returns {object}
 */
export function createEvolutionMetadata(init = {}) {
  return {
    generation: init.generation ?? INITIAL_GENERATION,
    keyVersion: init.keyVersion ?? { current: INITIAL_GENERATION, previous: null, next: null },
    evolutionCount: init.evolutionCount ?? 0,
    lastEvolutionAt: init.lastEvolutionAt ?? null,
  };
}

/**
 * Build the policy metadata block from a set of policy descriptors.
 * @param {import("../types/types.js").PolicyDescriptor[]} [policies]
 * @param {{ at?: string|null }} [options]
 * @returns {object}
 */
export function createPolicyMetadata(policies = [], options = {}) {
  const list = policies ?? [];
  return {
    count: list.length,
    types: [...new Set(list.map((p) => p.type))],
    enabled: list.filter((p) => p.enabled !== false).length,
    lastPolicyUpdate: options.at ?? null,
  };
}

/**
 * Build the security metadata block. Every cryptographic guarantee is `false` in
 * Sprint 1 — the framework exists, the mechanisms do not yet.
 * @param {object} [overrides]
 * @returns {object}
 */
export function createSecurityMetadata(overrides = {}) {
  return {
    framework: EVOLUTION_FRAMEWORK,
    version: EVOLUTION_SCHEMA_VERSION,
    forwardSecrecy: false, // Layer 5 · future sprint
    automaticRekeying: false, // Layer 5 · future sprint
    ratcheting: false, // Layer 5 · future sprint
    postCompromiseSecurity: false, // Layer 5 · future sprint
    keyRotationPerformed: false, // NO key rotation happens in this framework yet
    ...overrides,
  };
}

/**
 * A single audit entry (append-only). Public + non-secret.
 * @param {string} action @param {{ at?: string, generation?: number, trigger?: string, reason?: string, actor?: string, details?: object }} [meta]
 * @returns {object}
 */
export function createAuditEntry(action, meta = {}) {
  const entry = { action, at: meta.at ?? new Date().toISOString() };
  if (meta.generation !== undefined) entry.generation = meta.generation;
  if (meta.trigger !== undefined) entry.trigger = meta.trigger;
  if (meta.reason !== undefined) entry.reason = meta.reason;
  if (meta.actor !== undefined) entry.actor = meta.actor;
  if (meta.details !== undefined) entry.details = meta.details;
  return entry;
}

/**
 * Append an audit entry immutably (returns a new array; caps length to avoid unbounded
 * growth). @param {object[]} audit @param {object} entry @param {number} [max=200]
 * @returns {object[]}
 */
export function appendAudit(audit, entry, max = 200) {
  const next = [...(audit ?? []), entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * FUTURE placeholder — ratchet metadata (Double Ratchet). Empty + inert in Sprint 1.
 * @returns {object}
 */
export function createRatchetMetadata() {
  return {
    enabled: false,
    rootKeyVersion: null, // future: pointer into the ratchet root chain
    sendingChainLength: null, // future
    receivingChainLength: null, // future
    reserved: true,
  };
}

/**
 * FUTURE placeholder — chain-key metadata (symmetric-key ratchet). Inert in Sprint 1.
 * @returns {object}
 */
export function createChainMetadata() {
  return {
    enabled: false,
    chainKeyVersion: null, // future
    chainIndex: null, // future
    reserved: true,
  };
}

/**
 * FUTURE placeholder — per-message-key metadata. Inert in Sprint 1.
 * @returns {object}
 */
export function createMessageMetadata() {
  return {
    enabled: false,
    messageKeyIndex: null, // future
    skippedKeys: null, // future: count of retained out-of-order message keys
    reserved: true,
  };
}

/**
 * Recompute the derived metadata blocks (evolution + policy + security) from a record's
 * live fields. Called after any mutation so the metadata framework stays consistent.
 * @param {import("../types/types.js").EvolutionRecord} record
 * @param {{ at?: string|null }} [options]
 * @returns {{ evolutionMetadata: object, policyMetadata: object }}
 */
export function recomputeMetadata(record, options = {}) {
  return {
    evolutionMetadata: createEvolutionMetadata({
      generation: record.generation,
      keyVersion: record.keyVersion,
      evolutionCount: (record.versionHistory ?? []).length,
      lastEvolutionAt: record.lastEvolutionAt ?? null,
    }),
    policyMetadata: createPolicyMetadata(record.policies, {
      at: options.at ?? record.policyMetadata?.lastPolicyUpdate ?? null,
    }),
  };
}
