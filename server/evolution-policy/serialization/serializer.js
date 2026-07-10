/**
 * @module evolution-policy/serialization
 *
 * Public DTOs for automatic-rekey policy state. Whitelists PUBLIC fields — the policy set,
 * config, current generation, execution history, rekey history, and metadata.
 *
 * @security Policy-state records never carry key material; this layer also strips the
 * in-memory `evaluate` function from custom policies (via {@link serializePolicy}).
 */

import { serializePolicy } from "../../session-evolution/policies/policies.js";
import { isActiveExecutionState } from "../types/types.js";

/**
 * @typedef {object} PublicRekeyStateDTO
 * @property {string} sessionId @property {string} [handshakeId]
 * @property {object[]} policies @property {object} config
 * @property {number} currentGeneration @property {number} messageCount
 * @property {string|null} lastRekeyAt @property {string|null} lastEvaluationAt
 * @property {object|null} pending @property {object[]} rekeyHistory
 * @property {object} metadata @property {object} security
 * @property {string} createdAt @property {string} updatedAt @property {number} schemaVersion
 * @property {boolean} isRekeying
 */

/**
 * Shape a policy-state record into its public DTO.
 * @param {object} state @param {{ includeExecutions?: boolean, includeAudit?: boolean }} [options]
 * @returns {PublicRekeyStateDTO}
 */
export function toPublicRekeyState(state, options = {}) {
  const dto = {
    sessionId: state.sessionId,
    handshakeId: state.handshakeId,
    policies: (state.policies ?? []).map(serializePolicy),
    config: { ...(state.config ?? {}) },
    currentGeneration: state.currentGeneration ?? 0,
    messageCount: state.messageCount ?? 0,
    lastRekeyAt: state.lastRekeyAt ?? null,
    lastEvaluationAt: state.lastEvaluationAt ?? null,
    pending: state.pending ? toPublicExecution(state.pending) : null,
    rekeyHistory: (state.rekeyHistory ?? []).map((r) => ({ ...r })),
    metadata: { ...(state.metadata ?? {}) },
    security: { ...(state.security ?? {}) },
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    schemaVersion: state.schemaVersion,
    isRekeying: Boolean(state.pending && isActiveExecutionState(state.pending.state)),
  };
  if (options.includeExecutions) dto.executions = (state.executions ?? []).map(toPublicExecution);
  if (options.includeAudit) dto.audit = (state.audit ?? []).map((a) => ({ ...a }));
  return dto;
}

/** One execution record's public view (metadata only). */
export function toPublicExecution(e) {
  return {
    executionId: e.executionId,
    sessionId: e.sessionId,
    state: e.state,
    trigger: e.trigger,
    policyId: e.policyId,
    reason: e.reason,
    expectedGeneration: e.expectedGeneration,
    resultGeneration: e.resultGeneration,
    attempts: e.attempts,
    maxAttempts: e.maxAttempts,
    error: e.error,
    createdAt: e.createdAt,
    startedAt: e.startedAt,
    completedAt: e.completedAt,
    failedAt: e.failedAt,
  };
}

/** A compact status view — current generation + whether a rekey is in flight. */
export function toRekeyStatus(state) {
  return {
    sessionId: state.sessionId,
    enabled: state.config?.enabled !== false,
    policyCount: (state.policies ?? []).length,
    currentGeneration: state.currentGeneration ?? 0,
    isRekeying: Boolean(state.pending && isActiveExecutionState(state.pending.state)),
    lastRekeyAt: state.lastRekeyAt ?? null,
  };
}
