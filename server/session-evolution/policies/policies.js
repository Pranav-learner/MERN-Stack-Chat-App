/**
 * @module session-evolution/policies
 *
 * **Evolution Policies** — reusable, serializable descriptors that answer ONE question:
 * *when* should a session evolve? A policy NEVER performs rekeying and never touches
 * key material. It is a pure predicate over an evolution record + an evaluation context.
 *
 * Policy kinds ({@link PolicyType}):
 * - **time-based** — evolve after `intervalMs` since the last evolution.
 * - **message-count** — evolve after `maxMessages` messages since the last evolution.
 * - **manual** — evolve only when the caller explicitly requests it.
 * - **security-event** — evolve on a matching security signal (e.g. suspected compromise).
 * - **device-event** — evolve on a device change (add / remove / rotate).
 * - **administrator** — evolve on an administrator directive.
 * - **custom** — evolve per a caller-supplied predicate (in-memory only; not serialized).
 *
 * Descriptors are plain JSON (except `custom`, which keeps an in-memory `evaluate`
 * function) so the {@link module:session-evolution/repository} can persist them and any
 * transport (REST / WebSocket / WebRTC / P2P) can reuse them.
 *
 * @security Pure decision logic. No cryptography, no key rotation — this sprint only
 * decides WHEN evolution *would* occur.
 */

import crypto from "node:crypto";
import { PolicyType, ALL_POLICY_TYPES, INITIAL_GENERATION } from "../types/types.js";
import { EvolutionValidationError } from "../errors.js";

const genId = () => crypto.randomUUID();

/**
 * Normalize an evaluator result into `{ triggered, reason }`.
 * @param {boolean|{triggered:boolean,reason?:string}} result @param {string} [defaultReason]
 */
function normalizeResult(result, defaultReason) {
  if (typeof result === "boolean") return { triggered: result, reason: result ? defaultReason : undefined };
  return { triggered: Boolean(result?.triggered), reason: result?.reason ?? (result?.triggered ? defaultReason : undefined) };
}

/**
 * Evolve after a fixed interval elapses since the last evolution (or creation).
 * @param {{ intervalMs: number, id?: string, description?: string, enabled?: boolean }} params
 * @returns {import("../types/types.js").PolicyDescriptor}
 * @example const p = createTimeBasedPolicy({ intervalMs: 24 * 60 * 60 * 1000 });
 */
export function createTimeBasedPolicy({ intervalMs, id, description, enabled = true } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new EvolutionValidationError("time-based policy requires a positive intervalMs", { details: { intervalMs } });
  }
  return {
    id: id ?? genId(),
    type: PolicyType.TIME_BASED,
    params: { intervalMs },
    description: description ?? `Evolve every ${intervalMs}ms`,
    enabled,
  };
}

/**
 * Evolve after N messages since the last evolution.
 * @param {{ maxMessages: number, id?: string, description?: string, enabled?: boolean }} params
 * @returns {import("../types/types.js").PolicyDescriptor}
 */
export function createMessageCountPolicy({ maxMessages, id, description, enabled = true } = {}) {
  if (!Number.isInteger(maxMessages) || maxMessages <= 0) {
    throw new EvolutionValidationError("message-count policy requires a positive integer maxMessages", { details: { maxMessages } });
  }
  return {
    id: id ?? genId(),
    type: PolicyType.MESSAGE_COUNT,
    params: { maxMessages },
    description: description ?? `Evolve every ${maxMessages} messages`,
    enabled,
  };
}

/**
 * Evolve only on an explicit manual request.
 * @param {{ id?: string, description?: string, enabled?: boolean }} [params]
 * @returns {import("../types/types.js").PolicyDescriptor}
 */
export function createManualPolicy({ id, description, enabled = true } = {}) {
  return {
    id: id ?? genId(),
    type: PolicyType.MANUAL,
    params: {},
    description: description ?? "Evolve only on explicit request",
    enabled,
  };
}

/**
 * Evolve on a matching security event (empty `events` matches any security signal).
 * @param {{ events?: string[], id?: string, description?: string, enabled?: boolean }} [params]
 * @returns {import("../types/types.js").PolicyDescriptor}
 */
export function createSecurityEventPolicy({ events = [], id, description, enabled = true } = {}) {
  return {
    id: id ?? genId(),
    type: PolicyType.SECURITY_EVENT,
    params: { events: [...events] },
    description: description ?? (events.length ? `Evolve on security events: ${events.join(", ")}` : "Evolve on any security event"),
    enabled,
  };
}

/**
 * Evolve on a matching device event (empty `events` matches any device change).
 * @param {{ events?: string[], id?: string, description?: string, enabled?: boolean }} [params]
 * @returns {import("../types/types.js").PolicyDescriptor}
 */
export function createDeviceEventPolicy({ events = [], id, description, enabled = true } = {}) {
  return {
    id: id ?? genId(),
    type: PolicyType.DEVICE_EVENT,
    params: { events: [...events] },
    description: description ?? (events.length ? `Evolve on device events: ${events.join(", ")}` : "Evolve on any device event"),
    enabled,
  };
}

/**
 * Evolve on an administrator directive.
 * @param {{ id?: string, description?: string, enabled?: boolean }} [params]
 * @returns {import("../types/types.js").PolicyDescriptor}
 */
export function createAdministratorPolicy({ id, description, enabled = true } = {}) {
  return {
    id: id ?? genId(),
    type: PolicyType.ADMINISTRATOR,
    params: {},
    description: description ?? "Evolve on administrator directive",
    enabled,
  };
}

/**
 * Evolve per a caller-supplied predicate. The `evaluate` function is kept ON the
 * descriptor for in-memory use but is NOT serialized to storage.
 * @param {{ evaluate: (state: object, context: object) => (boolean|{triggered:boolean,reason?:string}), id?: string, description?: string, params?: object, enabled?: boolean }} params
 * @returns {import("../types/types.js").PolicyDescriptor}
 */
export function createCustomPolicy({ evaluate, id, description, params = {}, enabled = true } = {}) {
  if (typeof evaluate !== "function") {
    throw new EvolutionValidationError("custom policy requires an evaluate(state, context) function", {});
  }
  return {
    id: id ?? genId(),
    type: PolicyType.CUSTOM,
    params: { ...params },
    description: description ?? "Custom evolution policy",
    enabled,
    evaluate,
  };
}

/**
 * The per-type evaluators. Each answers: given this record + context, should evolution
 * occur now? All are pure; none rotate keys.
 * @type {Record<string, (policy: object, state: object, context: object) => (boolean|object)>}
 */
export const POLICY_EVALUATORS = Object.freeze({
  [PolicyType.TIME_BASED]: (policy, state, context) => {
    const now = context.now ?? Date.now();
    const since = new Date(state.lastEvolutionAt ?? state.createdAt ?? new Date(now).toISOString()).getTime();
    return now - since >= policy.params.intervalMs;
  },
  [PolicyType.MESSAGE_COUNT]: (policy, _state, context) => {
    const count = context.messagesSinceLastEvolution ?? context.messageCount ?? 0;
    return count >= policy.params.maxMessages;
  },
  [PolicyType.MANUAL]: (_policy, _state, context) => context.manual === true || context.trigger === PolicyType.MANUAL,
  [PolicyType.SECURITY_EVENT]: (policy, _state, context) => {
    const evt = context.securityEvent;
    if (!evt) return false;
    const allowed = policy.params.events ?? [];
    return allowed.length === 0 || allowed.includes(evt);
  },
  [PolicyType.DEVICE_EVENT]: (policy, _state, context) => {
    const evt = context.deviceEvent;
    if (!evt) return false;
    const allowed = policy.params.events ?? [];
    return allowed.length === 0 || allowed.includes(evt);
  },
  [PolicyType.ADMINISTRATOR]: (_policy, _state, context) => context.administrator === true || context.admin === true,
  [PolicyType.CUSTOM]: (policy, state, context) => (typeof policy.evaluate === "function" ? policy.evaluate(state, context) : false),
});

/**
 * Evaluate ONE policy against a record + context.
 * @param {import("../types/types.js").PolicyDescriptor} policy
 * @param {object} state the evolution record
 * @param {object} [context] evaluation signals (now, messagesSinceLastEvolution, manual, securityEvent, deviceEvent, administrator, …)
 * @returns {{ policyId: string, type: string, triggered: boolean, reason?: string }}
 */
export function evaluatePolicy(policy, state, context = {}) {
  if (policy.enabled === false) return { policyId: policy.id, type: policy.type, triggered: false };
  const evaluator = POLICY_EVALUATORS[policy.type];
  if (!evaluator) {
    throw new EvolutionValidationError(`Unknown policy type "${policy.type}"`, { details: { type: policy.type } });
  }
  const { triggered, reason } = normalizeResult(evaluator(policy, state, context), `${policy.type} policy satisfied`);
  return { policyId: policy.id, type: policy.type, triggered, reason };
}

/**
 * Evaluate ALL of a record's policies. Returns every result plus the triggered subset.
 * @param {object} state the evolution record (uses `state.policies`)
 * @param {object} [context]
 * @returns {{ results: object[], triggered: object[], anyTriggered: boolean }}
 */
export function evaluatePolicies(state, context = {}) {
  const results = (state.policies ?? []).map((p) => evaluatePolicy(p, state, context));
  const triggered = results.filter((r) => r.triggered);
  return { results, triggered, anyTriggered: triggered.length > 0 };
}

/** Whether a value is a well-formed policy descriptor. */
export function isPolicyDescriptor(policy) {
  return Boolean(policy) && typeof policy === "object" && typeof policy.id === "string" && ALL_POLICY_TYPES.includes(policy.type);
}

/**
 * A serializable copy of a policy descriptor (drops the `evaluate` function of custom
 * policies so it is storage-safe).
 * @param {import("../types/types.js").PolicyDescriptor} policy
 * @returns {object}
 */
export function serializePolicy(policy) {
  return {
    id: policy.id,
    type: policy.type,
    params: { ...(policy.params ?? {}) },
    description: policy.description,
    enabled: policy.enabled !== false,
  };
}

export { INITIAL_GENERATION };
