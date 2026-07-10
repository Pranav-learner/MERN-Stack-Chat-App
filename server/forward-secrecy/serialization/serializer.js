/**
 * @module forward-secrecy/serialization
 *
 * Public DTOs for forward-secrecy state. This is the API/network guardrail: it whitelists
 * PUBLIC fields — the current generation, per-generation METADATA (keyId, fingerprint,
 * algorithm, status, timestamps), destruction records, and security flags.
 *
 * @security A forward-secrecy state record never contains key bytes, but this layer also
 * defensively refuses to emit anything key-like. Chain secrets and derived keys live only
 * in the device key store and are structurally unreachable from here.
 */

import { LIVE_GENERATION_STATUSES } from "../types/types.js";

const LIVE = new Set(LIVE_GENERATION_STATUSES);

/**
 * @typedef {object} PublicForwardSecrecyDTO
 * @property {string} sessionId @property {string} [handshakeId]
 * @property {boolean} started @property {number} currentGeneration
 * @property {object[]} generations PUBLIC generation metadata
 * @property {number} liveGenerations count of generations whose keys still exist
 * @property {object[]} destructions @property {object} security
 * @property {string} createdAt @property {string} updatedAt @property {number} schemaVersion
 */

/**
 * Shape a forward-secrecy state record into its public DTO.
 * @param {object} state @param {{ includeAudit?: boolean }} [options]
 * @returns {PublicForwardSecrecyDTO}
 */
export function toPublicForwardSecrecy(state, options = {}) {
  const generations = (state.generations ?? []).map(toPublicGeneration);
  const dto = {
    sessionId: state.sessionId,
    handshakeId: state.handshakeId,
    started: Boolean(state.started),
    currentGeneration: state.currentGeneration ?? 0,
    generations,
    liveGenerations: generations.filter((g) => LIVE.has(g.status)).length,
    destructions: (state.destructions ?? []).map((d) => ({ ...d })),
    security: { ...(state.security ?? {}) },
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    schemaVersion: state.schemaVersion,
  };
  if (options.includeAudit) dto.audit = (state.audit ?? []).map((a) => ({ ...a }));
  return dto;
}

/** One generation's PUBLIC metadata (never keys). */
export function toPublicGeneration(g) {
  return {
    generation: g.generation,
    keyId: g.keyId,
    fingerprint: g.fingerprint,
    algorithm: g.algorithm,
    status: g.status,
    createdAt: g.createdAt,
    activatedAt: g.activatedAt,
    supersededAt: g.supersededAt,
    destroyedAt: g.destroyedAt,
    trigger: g.trigger,
    reason: g.reason,
  };
}

/**
 * A compact status view — the current generation + whether FS is active.
 * @param {object} state @returns {{ sessionId: string, started: boolean, currentGeneration: number, activeKeyId: string|null, forwardSecrecy: boolean }}
 */
export function toForwardSecrecyStatus(state) {
  const active = (state.generations ?? []).find((g) => g.generation === state.currentGeneration);
  return {
    sessionId: state.sessionId,
    started: Boolean(state.started),
    currentGeneration: state.currentGeneration ?? 0,
    activeKeyId: active?.keyId ?? null,
    forwardSecrecy: Boolean(state.security?.forwardSecrecy),
  };
}
