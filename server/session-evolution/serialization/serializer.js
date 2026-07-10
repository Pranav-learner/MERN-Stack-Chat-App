/**
 * @module session-evolution/serialization
 *
 * Public DTO for an evolution record. This is the API/network guardrail: it whitelists
 * PUBLIC fields — evolution identity, the session it tracks, lifecycle state, the
 * generation timeline, key-version POINTERS (integers), policy descriptors, pending
 * schedule, and the metadata framework blocks. Evolution records never contain key
 * bytes, but this layer also defensively strips anything key-like from custom policies.
 */

import { serializePolicy } from "../policies/policies.js";
import { ACTIVE_EVOLUTION_STATES, PENDING_EVOLUTION_STATES } from "../types/types.js";

const ACTIVE = new Set(ACTIVE_EVOLUTION_STATES);
const PENDING = new Set(PENDING_EVOLUTION_STATES);

/**
 * @typedef {object} PublicEvolutionDTO
 * @property {string} evolutionId @property {string} sessionId @property {string} [handshakeId]
 * @property {string} state @property {number} generation
 * @property {import("../types/types.js").KeyVersion} keyVersion
 * @property {object[]} versionHistory @property {object[]} policies
 * @property {object|null} pending
 * @property {string} createdAt @property {string} updatedAt @property {string|null} lastEvolutionAt
 * @property {object} evolutionMetadata @property {object} policyMetadata @property {object} securityMetadata
 * @property {object} metadata @property {number} schemaVersion
 * @property {boolean} isActive @property {boolean} isPending @property {boolean} isRetired
 */

/**
 * Shape an evolution record into its public DTO.
 * @param {object} record @param {{ now?: number, includeAudit?: boolean }} [context]
 * @returns {PublicEvolutionDTO}
 */
export function toPublicEvolution(record, context = {}) {
  const dto = {
    evolutionId: record.evolutionId,
    sessionId: record.sessionId,
    handshakeId: record.handshakeId,
    state: record.state,
    generation: record.generation ?? 0,
    keyVersion: {
      current: record.keyVersion?.current ?? record.generation ?? 0,
      previous: record.keyVersion?.previous ?? null,
      next: record.keyVersion?.next ?? null,
    },
    versionHistory: (record.versionHistory ?? []).map((h) => ({ ...h })),
    policies: (record.policies ?? []).map(serializePolicy),
    pending: record.pending ? { ...record.pending } : null,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
    lastEvolutionAt: record.lastEvolutionAt ? toIso(record.lastEvolutionAt) : null,
    evolutionMetadata: { ...(record.evolutionMetadata ?? {}) },
    policyMetadata: { ...(record.policyMetadata ?? {}) },
    securityMetadata: { ...(record.securityMetadata ?? {}) },
    metadata: record.metadata ?? {},
    schemaVersion: record.schemaVersion,
    isActive: ACTIVE.has(record.state),
    isPending: PENDING.has(record.state),
    isRetired: record.state === "retired",
  };
  if (context.includeAudit) dto.audit = (record.audit ?? []).map((a) => ({ ...a }));
  return dto;
}

/**
 * A compact status view — just enough for a client to know the current generation and
 * whether an evolution is queued.
 * @param {object} record @returns {{ sessionId: string, state: string, generation: number, isPending: boolean, isRetired: boolean }}
 */
export function toEvolutionStatus(record) {
  return {
    sessionId: record.sessionId,
    evolutionId: record.evolutionId,
    state: record.state,
    generation: record.generation ?? 0,
    isPending: PENDING.has(record.state),
    isRetired: record.state === "retired",
  };
}

/**
 * The metadata framework bundle for a record — the public "expose evolution metadata"
 * surface. Contains descriptors + counters only; never key material.
 * @param {object} record
 * @returns {{ evolution: object, policy: object, security: object, ratchet: object, chain: object, message: object }}
 */
export function toEvolutionMetadata(record) {
  return {
    evolution: { ...(record.evolutionMetadata ?? {}) },
    policy: { ...(record.policyMetadata ?? {}) },
    security: { ...(record.securityMetadata ?? {}) },
    // FUTURE placeholders — surfaced so consumers can detect the framework is present.
    ratchet: { ...(record.ratchetMetadata ?? {}) },
    chain: { ...(record.chainMetadata ?? {}) },
    message: { ...(record.messageMetadata ?? {}) },
  };
}

function toIso(value) {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}
