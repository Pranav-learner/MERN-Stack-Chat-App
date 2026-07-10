/**
 * @module evolution-policy/manager
 *
 * The **Automatic Rekey Manager** — the facade that makes cryptographic session evolution
 * automatic. It binds evolution policies to a session, evaluates them deterministically,
 * and drives the Sprint 2 forward-secrecy engine to rekey when a policy fires — with no
 * manual or developer intervention.
 *
 * Responsibilities (Step 4): evaluate policies · trigger evolution · queue rekey operations
 * · prevent duplicate rekeys · validate evolution · coordinate with the session/FS engine ·
 * update the generation. It performs NO cryptography itself — the {@link ForwardSecrecyManager}
 * owns all key material; this manager decides *when* and orchestrates the *execution*.
 *
 * ## Abuse / DoS guards
 * - **Cooldown** — automatic rekeys are rate-limited to at most one per `cooldownMs`
 *   (manual + security-event triggers bypass it).
 * - **Duplicate prevention** — an active execution blocks a second; a stale trigger for an
 *   already-advanced generation is coalesced by the execution engine.
 *
 * @security Metadata only. Automatic evolution never exposes keys; the crypto is delegated.
 *
 * @example
 * ```js
 * const rekey = new AutomaticRekeyManager({ ...createInMemoryPolicyRepository(), forwardSecrecy });
 * await rekey.configure(sessionId, { handshakeId, policies: [createMessageCountPolicy({ maxMessages: 100 })] });
 * await rekey.recordMessage(sessionId);  // ← transparently rekeys once the threshold is hit
 * ```
 */

import {
  RekeyEventType,
  TriggerType,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_HISTORY_LIMIT,
  REKEY_SCHEMA_VERSION,
} from "../types/types.js";
import { RekeyValidationError, RekeyExecutionError } from "../errors.js";
import { PolicyType } from "../policies/policyFactory.js";
import { evaluatePolicies } from "../evaluator/policyEvaluator.js";
import { RekeyExecutionEngine } from "../execution/executionEngine.js";
import { RekeyScheduler } from "../scheduler/rekeyScheduler.js";
import { MessageCounter, buildEvaluationContext } from "../triggers/triggers.js";
import { RekeyEventBus } from "../events/events.js";
import { createSecurityMetadata, recomputeMetadata } from "../metadata/metadata.js";
import { auditEntry, appendAudit, AuditAction } from "../audit/audit.js";
import {
  validateSessionRef,
  requireState,
  validatePolicyDescriptor,
  assertNoPolicyConflict,
  assertNoDuplicateExecution,
  assertSessionNotExpired,
  validateRekeyRequest,
  validateRepository,
} from "../validators/validators.js";
import { serializePolicy } from "../../session-evolution/policies/policies.js";
import { toPublicRekeyState, toRekeyStatus, toPublicExecution } from "../serialization/serializer.js";

export class AutomaticRekeyManager {
  /**
   * @param {object} deps
   * @param {object} deps.rekeyPolicies policy-state repository (required)
   * @param {object} deps.forwardSecrecy the Sprint 2 ForwardSecrecyManager (drives the crypto)
   * @param {RekeyEventBus} [deps.events] @param {RekeyExecutionEngine} [deps.execution] @param {RekeyScheduler} [deps.scheduler]
   * @param {MessageCounter} [deps.messageCounter] @param {object} [deps.sessions] a SecureSessionManager (status lookups)
   * @param {() => number} [deps.clock] @param {number} [deps.cooldownMs] @param {number} [deps.maxAttempts]
   * @param {(scope: string, error: Error) => void} [deps.onError]
   */
  constructor(deps) {
    if (!deps || !deps.rekeyPolicies) throw new Error("AutomaticRekeyManager requires { rekeyPolicies }");
    if (!deps.forwardSecrecy) throw new Error("AutomaticRekeyManager requires { forwardSecrecy }");
    this.repo = validateRepository(deps.rekeyPolicies);
    this.fs = deps.forwardSecrecy;
    this.sessions = deps.sessions ?? null;
    this.events = deps.events ?? new RekeyEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this._onError = deps.onError ?? ((scope, error) => console.error(`[auto-rekey] ${scope}:`, error?.message));
    this.messageCounter = deps.messageCounter ?? new MessageCounter();
    this.scheduler = deps.scheduler ?? new RekeyScheduler({ clock: this.clock });
    this.execution = deps.execution ?? new RekeyExecutionEngine({ events: this.events, clock: this.clock, maxAttempts: this.maxAttempts, onError: this._onError });
  }

  // === configuration =======================================================

  /**
   * Configure automatic rekeying for a session (create or replace). Registers time-based /
   * session-age policies with the scheduler so they fire autonomously.
   * @param {object} params
   * @param {string} params.sessionId @param {string} [params.handshakeId] @param {string} [params.sessionCreatedAt]
   * @param {import("../../session-evolution/types/types.js").PolicyDescriptor[]} [params.policies]
   * @param {boolean} [params.enabled] @param {number} [params.cooldownMs] @param {number} [params.maxAttempts]
   * @returns {Promise<object>} the public policy-state DTO
   */
  async configure(params) {
    validateSessionRef(params.sessionId);
    const policies = (params.policies ?? []).map((p) => validatePolicyDescriptor(p));
    // conflict-check within the provided set
    const accepted = [];
    for (const p of policies) {
      assertNoPolicyConflict(accepted, p);
      accepted.push(p);
    }
    const at = this._iso();
    const existing = await this.repo.findBySessionId(params.sessionId);
    const config = {
      enabled: params.enabled ?? true,
      cooldownMs: params.cooldownMs ?? this.cooldownMs,
      maxAttempts: params.maxAttempts ?? this.maxAttempts,
    };
    const base = existing ?? {
      sessionId: String(params.sessionId),
      handshakeId: params.handshakeId,
      sessionCreatedAt: params.sessionCreatedAt ?? at,
      currentGeneration: await this._currentGeneration(params.sessionId),
      messageCount: 0,
      lastRekeyAt: null,
      lastEvaluationAt: null,
      pending: null,
      executions: [],
      rekeyHistory: [],
      audit: [],
      createdAt: at,
      schemaVersion: REKEY_SCHEMA_VERSION,
    };
    const record = {
      ...base,
      handshakeId: params.handshakeId ?? base.handshakeId,
      sessionCreatedAt: params.sessionCreatedAt ?? base.sessionCreatedAt,
      policies: accepted.map(keepEval),
      config,
      security: createSecurityMetadata(config),
      audit: appendAudit(base.audit, auditEntry(AuditAction.CONFIGURED, { at, details: { policies: accepted.length } })),
      updatedAt: at,
    };
    record.metadata = recomputeMetadata(record, { at });
    if (existing) await this.repo.update(params.sessionId, record);
    else await this.repo.create(record);

    this._registerSchedules(record, this.clock());
    this.events.emit(RekeyEventType.POLICY_CONFIGURED, { sessionId: record.sessionId, details: { policies: accepted.length } });
    return toPublicRekeyState(record);
  }

  /** Attach one policy (validated + conflict-checked). */
  async attachPolicy(sessionId, policy) {
    const state = await this._require(sessionId);
    validatePolicyDescriptor(policy);
    assertNoPolicyConflict(state.policies, policy);
    const policies = [...state.policies, keepEval(policy)];
    return this._savePolicies(state, policies, { action: AuditAction.POLICY_ATTACHED, policyId: policy.id, policyType: policy.type });
  }

  /** Remove one policy by id. */
  async removePolicy(sessionId, policyId) {
    const state = await this._require(sessionId);
    const policies = state.policies.filter((p) => p.id !== policyId);
    if (policies.length === state.policies.length) throw new RekeyValidationError(`No policy with id "${policyId}"`, { details: { policyId } });
    return this._savePolicies(state, policies, { action: AuditAction.POLICY_REMOVED, policyId });
  }

  /** Enable / disable automatic rekeying for a session. */
  async setEnabled(sessionId, enabled) {
    const state = await this._require(sessionId);
    const updated = await this.repo.update(sessionId, { config: { ...state.config, enabled: Boolean(enabled) }, updatedAt: this._iso() });
    return toPublicRekeyState(updated);
  }

  // === evaluation + automatic rekey =======================================

  /**
   * Deterministically evaluate a session's policies against the current context.
   * @param {string} sessionId @param {object} [context] extra signals (securityEvent, deviceEvent, manual, …)
   * @returns {Promise<{ results: object[], triggered: object[], anyTriggered: boolean, firstTrigger: object|null }>}
   */
  async evaluate(sessionId, context = {}) {
    const state = await this._require(sessionId);
    const outcome = this._evaluate(state, context);
    await this.repo.update(sessionId, { lastEvaluationAt: this._iso(), updatedAt: this._iso() });
    this.events.emit(RekeyEventType.POLICY_EVALUATED, { sessionId: state.sessionId, details: { anyTriggered: outcome.anyTriggered, triggered: outcome.triggered.map((t) => t.type) } });
    return outcome;
  }

  /**
   * Evaluate and, if a policy fires (and cooldown permits), automatically rekey. This is
   * the autonomous core — callers usually reach it via {@link recordMessage},
   * {@link onSecurityEvent}, {@link onDeviceEvent}, or {@link tick}.
   * @param {string} sessionId @param {object} [context]
   * @returns {Promise<{ evaluated: boolean, rekeyed: boolean, reason?: string, execution?: object }>}
   */
  async evaluateAndRekey(sessionId, context = {}) {
    const state = await this._require(sessionId);
    if (state.config?.enabled === false) return { evaluated: false, rekeyed: false, reason: "disabled" };
    const outcome = this._evaluate(state, context);
    await this.repo.update(sessionId, { lastEvaluationAt: this._iso(), updatedAt: this._iso() });
    this.events.emit(RekeyEventType.POLICY_EVALUATED, { sessionId: state.sessionId, details: { anyTriggered: outcome.anyTriggered } });
    if (!outcome.anyTriggered) return { evaluated: true, rekeyed: false };

    const trig = outcome.firstTrigger;
    const triggerType = mapPolicyToTrigger(trig.type);
    if (this._inCooldown(state, this.clock(), triggerType)) {
      return { evaluated: true, rekeyed: false, reason: "cooldown-active" };
    }
    const result = await this.trigger(sessionId, { trigger: triggerType, reason: trig.reason ?? trig.type, policyId: trig.policyId });
    return { evaluated: true, rekeyed: Boolean(result.executed), execution: result.execution };
  }

  /**
   * Trigger a rekey execution (queued, serialized, deduplicated). Low-level; prefer the
   * automatic entrypoints. Manual triggers bypass the cooldown.
   * @param {string} sessionId @param {{ trigger?: string, reason?: string, policyId?: string }} [options]
   * @returns {Promise<{ execution: object, executed: boolean, coalesced?: boolean, generation?: number }>}
   */
  async trigger(sessionId, options = {}) {
    const state = await this._require(sessionId);
    validateRekeyRequest({ sessionId, reason: options.reason });
    await this._assertSessionEvolvable(sessionId);
    assertNoDuplicateExecution(state.pending);

    const expectedGeneration = await this._currentGeneration(sessionId);
    const trigger = options.trigger ?? TriggerType.MANUAL;
    this.events.emit(RekeyEventType.POLICY_TRIGGERED, { sessionId: state.sessionId, trigger, policyId: options.policyId, reason: options.reason });
    await this._audit(sessionId, AuditAction.TRIGGERED, { trigger, policyId: options.policyId, reason: options.reason });

    const result = await this.execution.submit(
      { sessionId, trigger, policyId: options.policyId, reason: options.reason, expectedGeneration },
      {
        currentGeneration: () => this._currentGeneration(sessionId),
        evolve: () => this.fs.evolve(sessionId, { reason: options.reason ?? trigger, trigger }),
        persist: (execution) => this._persistExecution(sessionId, execution),
      },
    );

    if (result.executed) await this._onRekeyCompleted(sessionId, result, trigger, options.reason);
    else if (result.error) throw new RekeyExecutionError("Rekey execution failed", { cause: result.error, details: { sessionId } });
    return result;
  }

  // === reactive triggers ===================================================

  /**
   * Record `n` sent messages and transparently rekey if a message-count (or other) policy
   * now fires. Applications call this on send; they never see the rekey.
   * @param {string} sessionId @param {number} [n=1] @returns {Promise<object>} evaluateAndRekey result
   */
  async recordMessage(sessionId, n = 1) {
    await this._require(sessionId);
    const count = this.messageCounter.increment(sessionId, n);
    await this.repo.update(sessionId, { messageCount: count, updatedAt: this._iso() }).catch((e) => this._onError("recordMessage", e));
    return this.evaluateAndRekey(sessionId, { now: this.clock(), messagesSinceLastEvolution: count });
  }

  /** A security event fired — evaluate + rekey immediately (bypasses cooldown). */
  async onSecurityEvent(sessionId, event, options = {}) {
    return this.evaluateAndRekey(sessionId, { now: this.clock(), securityEvent: event, ...options });
  }

  /** A device event fired (add / remove / reconnect) — evaluate + rekey. */
  async onDeviceEvent(sessionId, event, options = {}) {
    return this.evaluateAndRekey(sessionId, { now: this.clock(), deviceEvent: event, ...options });
  }

  /** An explicit manual rekey (bypasses cooldown + policy evaluation). */
  async manualRekey(sessionId, options = {}) {
    return this.trigger(sessionId, { trigger: TriggerType.MANUAL, reason: options.reason ?? "manual" });
  }

  /**
   * Autonomous scheduler tick: evaluate + rekey every session whose time-based /
   * session-age schedule is due.
   * @param {number} [now] @returns {Promise<{ due: number, rekeyed: number, sessionIds: string[] }>}
   */
  async tick(now = this.clock()) {
    const due = this.scheduler.due(now);
    let rekeyed = 0;
    const sessionIds = [];
    for (const sessionId of due) {
      try {
        const r = await this.evaluateAndRekey(sessionId, { now });
        if (r.rekeyed) {
          rekeyed++;
          sessionIds.push(sessionId);
        }
      } catch (error) {
        this._onError("tick", error);
      } finally {
        this.scheduler.mark(sessionId, now);
      }
    }
    return { due: due.length, rekeyed, sessionIds };
  }

  /** Cancel a queued (PENDING, not yet executing) rekey for a session. */
  async cancelPending(sessionId) {
    const state = await this._require(sessionId);
    if (!state.pending || state.pending.state !== "pending") {
      return { cancelled: false, reason: "no-pending-execution" };
    }
    const cancelled = { ...state.pending, state: "cancelled", completedAt: this._iso() };
    await this.repo.update(sessionId, {
      pending: null,
      executions: appendCapped(state.executions, cancelled),
      audit: appendAudit(state.audit, auditEntry(AuditAction.REKEY_CANCELLED, { at: this._iso(), executionId: cancelled.executionId })),
      updatedAt: this._iso(),
    });
    this.events.emit(RekeyEventType.REKEY_CANCELLED, { sessionId: state.sessionId, executionId: cancelled.executionId });
    return { cancelled: true, executionId: cancelled.executionId };
  }

  // === queries =============================================================

  /** Full policy-state DTO. */
  async getState(sessionId) {
    return toPublicRekeyState(await this._require(sessionId), { includeExecutions: true });
  }

  /** Compact status. */
  async getStatus(sessionId) {
    return toRekeyStatus(await this._require(sessionId));
  }

  /** The DTO, or null if not configured. */
  async findState(sessionId) {
    validateSessionRef(sessionId);
    const state = await this.repo.findBySessionId(sessionId);
    return state ? toPublicRekeyState(state) : null;
  }

  /** Attached policies. */
  async getPolicies(sessionId) {
    return (await this._require(sessionId)).policies.map(serializePolicy);
  }

  /** Execution history. */
  async getExecutionHistory(sessionId) {
    return (await this._require(sessionId)).executions.map(toPublicExecution);
  }

  /** Rekey (generation-advance) history. */
  async getRekeyHistory(sessionId) {
    return (await this._require(sessionId)).rekeyHistory.map((r) => ({ ...r }));
  }

  /** Audit trail. */
  async getAudit(sessionId) {
    return (await this._require(sessionId)).audit.map((a) => ({ ...a }));
  }

  /** Remove all automatic-rekey state for a session (teardown). */
  async deconfigure(sessionId) {
    validateSessionRef(sessionId);
    this.scheduler.cancel(sessionId);
    this.messageCounter.delete(sessionId);
    return { sessionId: String(sessionId), removed: await this.repo.delete(sessionId) };
  }

  // === internals ==========================================================

  /** @private */
  async _require(sessionId) {
    validateSessionRef(sessionId);
    return requireState(await this.repo.findBySessionId(sessionId), sessionId);
  }

  /** @private Build the subject + context and evaluate. */
  _evaluate(state, context) {
    const ctx = buildEvaluationContext({
      now: context.now ?? this.clock(),
      messagesSinceLastEvolution: context.messagesSinceLastEvolution ?? this.messageCounter.get(state.sessionId),
      sessionCreatedAt: state.sessionCreatedAt,
      manual: context.manual,
      securityEvent: context.securityEvent,
      deviceEvent: context.deviceEvent,
      administrator: context.administrator,
    });
    const subject = { createdAt: state.createdAt, lastEvolutionAt: state.lastRekeyAt };
    return evaluatePolicies(state.policies, subject, ctx);
  }

  /** @private Persist policy-set change + recomputed metadata. */
  async _savePolicies(state, policies, meta) {
    const at = this._iso();
    const next = { ...state, policies };
    const updated = await this.repo.update(state.sessionId, {
      policies: policies.map(serializePolicy),
      metadata: recomputeMetadata(next, { at }),
      audit: appendAudit(state.audit, auditEntry(meta.action, { at, policyId: meta.policyId, policyType: meta.policyType })),
      updatedAt: at,
    });
    this._registerSchedules(updated, this.clock());
    this.events.emit(RekeyEventType.POLICY_CONFIGURED, { sessionId: state.sessionId, policyId: meta.policyId });
    return toPublicRekeyState(updated);
  }

  /** @private Register time-based / session-age policies with the scheduler. */
  _registerSchedules(record, now) {
    const timeBased = (record.policies ?? []).find((p) => p.type === PolicyType.TIME_BASED && p.enabled !== false);
    const sessionAge = (record.policies ?? []).find((p) => p.type === PolicyType.SESSION_AGE && p.enabled !== false);
    if (timeBased) {
      this.scheduler.register(record.sessionId, { intervalMs: timeBased.params.intervalMs, recurring: true, dueInMs: timeBased.params.intervalMs });
    } else if (sessionAge) {
      const createdMs = new Date(record.sessionCreatedAt ?? record.createdAt).getTime();
      this.scheduler.register(record.sessionId, { dueAt: createdMs + sessionAge.params.maxAgeMs });
    } else {
      this.scheduler.cancel(record.sessionId);
    }
  }

  /** @private Persist an execution snapshot (pending slot + history upsert). */
  async _persistExecution(sessionId, execution) {
    const state = await this.repo.findBySessionId(sessionId);
    if (!state) return;
    const terminal = ["completed", "failed", "cancelled"].includes(execution.state);
    const executions = upsertExecution(state.executions, execution);
    await this.repo.update(sessionId, {
      pending: terminal ? null : { ...execution },
      executions,
      audit: appendAudit(state.audit, auditEntry(auditActionFor(execution.state), { at: this._iso(), executionId: execution.executionId, trigger: execution.trigger, reason: execution.reason })),
      updatedAt: this._iso(),
    });
  }

  /** @private Post-rekey bookkeeping: generation, history, counter reset, reschedule. */
  async _onRekeyCompleted(sessionId, result, trigger, reason) {
    const now = this.clock();
    const at = new Date(now).toISOString();
    const state = await this.repo.findBySessionId(sessionId);
    if (!state) return;
    const generation = result.generation ?? (await this._currentGeneration(sessionId));
    await this.repo.update(sessionId, {
      currentGeneration: generation,
      lastRekeyAt: at,
      messageCount: 0,
      rekeyHistory: appendCapped(state.rekeyHistory, { generation, trigger, reason, at }),
      updatedAt: at,
    });
    this.messageCounter.reset(sessionId);
    this.scheduler.mark(sessionId, now);
    this.events.emit(RekeyEventType.GENERATION_UPDATED, { sessionId: String(sessionId), generation, previousGeneration: result.execution?.expectedGeneration });
    this.events.emit(RekeyEventType.TRANSPORT_UPDATED, { sessionId: String(sessionId), generation });
  }

  /** @private Current generation from the FS engine (falls back to the record). */
  async _currentGeneration(sessionId) {
    try {
      const fsState = await this.fs.findState(sessionId);
      if (fsState) return fsState.currentGeneration;
    } catch (error) {
      this._onError("currentGeneration", error);
    }
    const state = await this.repo.findBySessionId(sessionId);
    return state?.currentGeneration ?? 0;
  }

  /** @private Assert the underlying session is evolvable (not expired), if a session manager is wired. */
  async _assertSessionEvolvable(sessionId) {
    if (!this.sessions) return;
    try {
      const status = await this.sessions.getStatus(sessionId);
      assertSessionNotExpired(status?.status);
    } catch (error) {
      if (error?.code?.startsWith?.("ERR_REKEY")) throw error;
      this._onError("assertSessionEvolvable", error); // unknown session status → best-effort
    }
  }

  /** @private Cooldown gate for automatic rekeys. */
  _inCooldown(state, now, trigger) {
    if (trigger === TriggerType.SECURITY_EVENT || trigger === TriggerType.MANUAL) return false;
    const cooldown = state.config?.cooldownMs ?? this.cooldownMs;
    if (!state.lastRekeyAt || !cooldown) return false;
    return now - new Date(state.lastRekeyAt).getTime() < cooldown;
  }

  /** @private */
  async _audit(sessionId, action, meta) {
    const state = await this.repo.findBySessionId(sessionId);
    if (!state) return;
    await this.repo.update(sessionId, { audit: appendAudit(state.audit, auditEntry(action, { at: this._iso(), ...meta })), updatedAt: this._iso() });
  }

  /** @private */
  _iso() {
    return new Date(this.clock()).toISOString();
  }
}

/** Keep a custom policy's in-memory `evaluate` fn while normalizing the descriptor shape. */
function keepEval(policy) {
  const base = serializePolicy(policy);
  return typeof policy.evaluate === "function" ? { ...base, evaluate: policy.evaluate } : base;
}

/** Map a policy type to the trigger type recorded on executions. */
function mapPolicyToTrigger(policyType) {
  switch (policyType) {
    case PolicyType.TIME_BASED:
      return TriggerType.TIME;
    case PolicyType.MESSAGE_COUNT:
      return TriggerType.MESSAGE_COUNT;
    case PolicyType.SECURITY_EVENT:
      return TriggerType.SECURITY_EVENT;
    case PolicyType.DEVICE_EVENT:
      return TriggerType.DEVICE_EVENT;
    case PolicyType.SESSION_AGE:
      return TriggerType.SESSION_AGE;
    case PolicyType.MANUAL:
      return TriggerType.MANUAL;
    default:
      return TriggerType.POLICY;
  }
}

/** Audit action for an execution state. */
function auditActionFor(state) {
  return {
    pending: AuditAction.REKEY_QUEUED,
    executing: AuditAction.REKEY_STARTED,
    completed: AuditAction.REKEY_COMPLETED,
    failed: AuditAction.REKEY_FAILED,
    cancelled: AuditAction.REKEY_CANCELLED,
  }[state] ?? AuditAction.REKEY_QUEUED;
}

/** Replace an execution by id, else append (capped). */
function upsertExecution(executions, execution) {
  const list = executions ?? [];
  const idx = list.findIndex((e) => e.executionId === execution.executionId);
  const next = idx >= 0 ? list.map((e, i) => (i === idx ? { ...execution } : e)) : [...list, { ...execution }];
  return next.length > DEFAULT_HISTORY_LIMIT ? next.slice(next.length - DEFAULT_HISTORY_LIMIT) : next;
}

/** Append with a history cap. */
function appendCapped(list, entry, max = DEFAULT_HISTORY_LIMIT) {
  const next = [...(list ?? []), entry];
  return next.length > max ? next.slice(next.length - max) : next;
}
