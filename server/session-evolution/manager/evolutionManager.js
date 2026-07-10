/**
 * @module session-evolution/manager
 *
 * The **Evolution Manager** — the reusable facade for the Session Evolution Framework
 * (Layer 5, Sprint 1). It owns an evolution record's lifecycle: create/load state,
 * attach/update policies, evaluate policies, schedule + cancel evolutions, advance
 * generations, validate, expose metadata, and retire. Future Layer 5 sprints (Forward
 * Secrecy, Automatic Rekeying, Ratcheting) plug their KEY mechanics into THIS manager
 * rather than redesigning the session architecture.
 *
 * @important Sprint 1 performs **NO cryptography**. `advanceGeneration` bumps the
 * generation counter + key-version pointers and records history; it does NOT derive,
 * rotate, or ratchet any key. `schedule` parks intent; it does NOT execute evolution.
 *
 * @security Records + DTOs + events carry PUBLIC metadata only (ids, states, generation
 * numbers, key-version pointers, policy descriptors) — never key bytes or secrets.
 *
 * @example
 * ```js
 * import { EvolutionManager, createInMemoryEvolutionRepository } from "./session-evolution/index.js";
 * const evo = new EvolutionManager({ ...createInMemoryEvolutionRepository() });
 * const rec = await evo.createEvolutionState({ sessionId, handshakeId });
 * await evo.attachPolicy(sessionId, createTimeBasedPolicy({ intervalMs: 86_400_000 }));
 * const advanced = await evo.advanceGeneration(sessionId, { reason: "manual" }); // no keys move
 * ```
 */

import crypto from "node:crypto";
import {
  EvolutionState,
  EvolutionEventType,
  EvolutionTrigger,
  EvolutionFailureReason,
} from "../types/types.js";
import { EvolutionValidationError, CorruptedEvolutionMetadataError } from "../errors.js";
import { assertEvolutionTransition } from "../lifecycle/lifecycle.js";
import { createEvolutionRecord, projectNextGeneration } from "../state/evolutionState.js";
import {
  buildVersionEntry,
  assertMonotonicAdvance,
  assertNoDuplicateGeneration,
  rollbackMetadata as computeRollbackMetadata,
  migrationSnapshot,
} from "../evolution/generations.js";
import { EvolutionScheduler } from "../schedulers/scheduler.js";
import { serializePolicy } from "../policies/policies.js";
import { createAuditEntry, appendAudit, recomputeMetadata } from "../metadata/metadata.js";
import {
  validateSessionRef,
  requireEvolution,
  assertNoDuplicateEvolution,
  assertNotRetired,
  validateEvolutionMetadata,
  validatePolicyDescriptor,
  assertNoPolicyConflict,
} from "../validators/validators.js";
import { toPublicEvolution, toEvolutionMetadata, toEvolutionStatus } from "../serialization/serializer.js";
import { EvolutionEventBus } from "../events/events.js";

export class EvolutionManager {
  /**
   * @param {object} deps
   * @param {object} deps.evolutions evolution repository (required)
   * @param {EvolutionEventBus} [deps.events]
   * @param {EvolutionScheduler} [deps.scheduler]
   * @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   * @param {import("../types/types.js").PolicyDescriptor[]} [deps.defaultPolicies]
   */
  constructor(deps) {
    if (!deps || !deps.evolutions) throw new Error("EvolutionManager requires { evolutions }");
    this.evolutions = deps.evolutions;
    this.events = deps.events ?? new EvolutionEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.scheduler = deps.scheduler ?? new EvolutionScheduler({ clock: this.clock });
    this.defaultPolicies = deps.defaultPolicies ?? [];
  }

  // === creation ============================================================

  /**
   * Create the evolution sidecar for a Secure Session and activate it
   * (INITIALIZED → STABLE). Idempotent-guarded: rejects a duplicate for the same session.
   * @param {object} params
   * @param {string} params.sessionId @param {string} [params.handshakeId]
   * @param {number} [params.generation] @param {import("../types/types.js").PolicyDescriptor[]} [params.policies]
   * @param {object} [params.metadata]
   * @returns {Promise<object>} the public evolution DTO
   */
  async createEvolutionState(params) {
    validateSessionRef(params.sessionId);
    assertNoDuplicateEvolution(await this.evolutions.findBySessionId(params.sessionId));

    const policies = (params.policies ?? this.defaultPolicies).map((p) => validatePolicyDescriptor(p) && serializePolicyKeepEval(p));
    const record = createEvolutionRecord({
      sessionId: params.sessionId,
      handshakeId: params.handshakeId,
      generation: params.generation,
      policies,
      metadata: params.metadata,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
    record.audit = appendAudit(record.audit, createAuditEntry("created", { at: nowIso(this.clock), generation: record.generation }));

    await this.evolutions.create(record);
    this.events.emit(EvolutionEventType.CREATED, {
      evolutionId: record.evolutionId,
      sessionId: record.sessionId,
      state: record.state,
      generation: record.generation,
    });
    return this._transition(record, EvolutionState.STABLE, { reason: "activated" });
  }

  // === queries =============================================================

  /** Load an evolution record by session id. @returns {Promise<object>} public DTO */
  async getEvolutionState(sessionId) {
    return toPublicEvolution(await this._require(sessionId), { now: this.clock() });
  }

  /** Load an evolution record by session id, or null if none exists. */
  async findEvolutionState(sessionId) {
    validateSessionRef(sessionId);
    const record = await this.evolutions.findBySessionId(sessionId);
    return record ? toPublicEvolution(record, { now: this.clock() }) : null;
  }

  /** Load by evolution id. @returns {Promise<object>} public DTO */
  async getByEvolutionId(evolutionId) {
    const record = requireEvolution(await this.evolutions.findById(evolutionId), evolutionId);
    return toPublicEvolution(record, { now: this.clock() });
  }

  /** Compact status view (current generation + whether an evolution is queued). */
  async getStatus(sessionId) {
    return toEvolutionStatus(await this._require(sessionId));
  }

  /** The metadata framework bundle (evolution/policy/security + future placeholders). */
  async getMetadata(sessionId) {
    return toEvolutionMetadata(await this._require(sessionId));
  }

  /** List evolution records in a given state. */
  async listByState(state) {
    return (await this.evolutions.findByState(state)).map((r) => toPublicEvolution(r, { now: this.clock() }));
  }

  /** Every evolution record. */
  async listAll() {
    return (await this.evolutions.listAll()).map((r) => toPublicEvolution(r, { now: this.clock() }));
  }

  /** The generation timeline snapshot (for migration / client reconciliation). */
  async getMigrationSnapshot(sessionId) {
    return migrationSnapshot(await this._require(sessionId));
  }

  /** Rollback METADATA for the last advance (no keys are restored — Sprint 1). */
  async getRollbackMetadata(sessionId) {
    return computeRollbackMetadata(await this._require(sessionId));
  }

  // === policies ============================================================

  /**
   * Attach a policy (validated + conflict-checked). Emits POLICY_UPDATED.
   * @param {string} sessionId @param {import("../types/types.js").PolicyDescriptor} policy
   * @returns {Promise<object>} public DTO
   */
  async attachPolicy(sessionId, policy) {
    const record = await this._require(sessionId);
    assertNotRetired(record);
    validatePolicyDescriptor(policy);
    assertNoPolicyConflict(record.policies, policy);
    const policies = [...record.policies, serializePolicyKeepEval(policy)];
    return this._updatePolicies(record, policies, { action: "policy-attached", policyId: policy.id, policyType: policy.type });
  }

  /** Remove a policy by id. Emits POLICY_UPDATED. */
  async removePolicy(sessionId, policyId) {
    const record = await this._require(sessionId);
    assertNotRetired(record);
    const policies = record.policies.filter((p) => p.id !== policyId);
    if (policies.length === record.policies.length) {
      throw new EvolutionValidationError(`No policy with id "${policyId}" is attached`, { details: { policyId } });
    }
    return this._updatePolicies(record, policies, { action: "policy-removed", policyId });
  }

  /** Replace the entire policy set. Emits POLICY_UPDATED. */
  async setPolicies(sessionId, policies) {
    const record = await this._require(sessionId);
    assertNotRetired(record);
    (policies ?? []).forEach(validatePolicyDescriptor);
    return this._updatePolicies(record, (policies ?? []).map(serializePolicyKeepEval), { action: "policies-replaced" });
  }

  // === evaluation + scheduling ============================================

  /**
   * Evaluate the record's policies against a context. Emits POLICY_TRIGGERED when any
   * policy fires. Does NOT schedule or execute anything.
   * @param {string} sessionId @param {object} [context]
   * @returns {Promise<{ results: object[], triggered: object[], anyTriggered: boolean }>}
   */
  async evaluate(sessionId, context = {}) {
    const record = await this._require(sessionId);
    const outcome = this.scheduler.evaluate(record, context);
    if (outcome.anyTriggered) {
      const first = outcome.triggered[0];
      this.events.emit(EvolutionEventType.POLICY_TRIGGERED, {
        evolutionId: record.evolutionId,
        sessionId: record.sessionId,
        policyId: first.policyId,
        policyType: first.type,
        reason: first.reason,
      });
    }
    return outcome;
  }

  /**
   * Schedule an evolution — deferred (with `dueInMs`/`dueAt`) or immediately pending.
   * Records the intent on the record + scheduler and transitions STABLE → SCHEDULED (or
   * → PENDING when due immediately). Emits SCHEDULED. Does NOT execute evolution.
   * @param {string} sessionId
   * @param {{ reason?: string, trigger?: string, policyId?: string, policyType?: string, dueInMs?: number, dueAt?: string|null }} [options]
   * @returns {Promise<object>} public DTO
   */
  async schedule(sessionId, options = {}) {
    const record = await this._require(sessionId);
    assertNotRetired(record);
    const deferred = options.dueInMs > 0 || (options.dueAt && new Date(options.dueAt).getTime() > this.clock());
    const targetGeneration = projectNextGeneration(record).generation;

    const plan = this.scheduler.schedule({
      sessionId: record.sessionId,
      evolutionId: record.evolutionId,
      targetGeneration,
      trigger: options.trigger ?? (deferred ? EvolutionTrigger.SCHEDULED : EvolutionTrigger.POLICY),
      reason: options.reason,
      policyId: options.policyId,
      policyType: options.policyType,
      dueInMs: options.dueInMs,
      dueAt: options.dueAt,
    });

    const toState = deferred ? EvolutionState.SCHEDULED : EvolutionState.PENDING;
    const dto = await this._transition(record, toState, {
      reason: options.reason,
      pending: pendingFromPlan(plan),
      event: EvolutionEventType.SCHEDULED,
      eventExtras: { trigger: plan.trigger, policyId: plan.policyId, generation: targetGeneration },
      audit: createAuditEntry("scheduled", { at: nowIso(this.clock), trigger: plan.trigger, reason: options.reason, details: { dueAt: plan.dueAt, targetGeneration } }),
    });
    return dto;
  }

  /** Cancel a scheduled/pending evolution and return to STABLE. Emits CANCELLED. */
  async cancelEvolution(sessionId, options = {}) {
    const record = await this._require(sessionId);
    assertNotRetired(record);
    if (![EvolutionState.SCHEDULED, EvolutionState.PENDING].includes(record.state)) {
      throw new EvolutionValidationError(`No pending evolution to cancel (state: ${record.state})`, { details: { state: record.state } });
    }
    this.scheduler.cancel(record.sessionId);
    // scheduled/pending → cancelled → stable
    const cancelled = await this._transition(record, EvolutionState.CANCELLED, {
      reason: options.reason ?? "cancelled",
      pending: null,
      event: EvolutionEventType.CANCELLED,
      audit: createAuditEntry("cancelled", { at: nowIso(this.clock), reason: options.reason }),
      returnRecord: true,
    });
    return this._transition(cancelled, EvolutionState.STABLE, { reason: "resumed-stable" });
  }

  // === generation advance (NO keys) =======================================

  /**
   * Advance the session to the next generation. Walks the state machine
   * (current → EVOLVING → EVOLVED → STABLE), bumps the generation counter + key-version
   * pointers, appends a version-history entry, clears any pending schedule, and emits
   * GENERATION_ADVANCED.
   *
   * @important NO key material is derived, rotated, or ratcheted. Only the metadata
   * timeline advances. A future Layer 5 sprint attaches key derivation here.
   *
   * @param {string} sessionId
   * @param {{ reason?: string, trigger?: string }} [options]
   * @returns {Promise<object>} public DTO (new generation)
   */
  async advanceGeneration(sessionId, options = {}) {
    const record = await this._require(sessionId);
    assertNotRetired(record);
    if (![EvolutionState.STABLE, EvolutionState.SCHEDULED, EvolutionState.PENDING].includes(record.state)) {
      throw new EvolutionValidationError(`Cannot advance generation from state "${record.state}"`, { details: { state: record.state } });
    }

    const previousGeneration = record.generation;
    const { generation, keyVersion } = projectNextGeneration(record);
    assertMonotonicAdvance(previousGeneration, generation);
    assertNoDuplicateGeneration(record.versionHistory, generation);

    const trigger = options.trigger ?? EvolutionTrigger.MANUAL;
    const at = nowIso(this.clock);
    const versionEntry = buildVersionEntry({
      generation,
      keyVersion: keyVersion.current,
      previousGeneration,
      previousKeyVersion: record.keyVersion?.current ?? previousGeneration,
      trigger,
      reason: options.reason,
      at,
    });

    // current → EVOLVING (framework-only; no crypto executes here)
    const evolving = await this._transition(record, EvolutionState.EVOLVING, {
      reason: options.reason ?? trigger,
      returnRecord: true,
    });
    // EVOLVING → EVOLVED, applying the new generation + timeline
    const evolved = await this._transition(evolving, EvolutionState.EVOLVED, {
      reason: "generation-applied",
      patch: {
        generation,
        keyVersion,
        versionHistory: [...(record.versionHistory ?? []), versionEntry],
        lastEvolutionAt: at,
        pending: null,
      },
      audit: createAuditEntry("generation-advanced", { at, generation, trigger, reason: options.reason }),
      returnRecord: true,
    });
    this.scheduler.cancel(record.sessionId);
    this.events.emit(EvolutionEventType.GENERATION_ADVANCED, {
      evolutionId: record.evolutionId,
      sessionId: record.sessionId,
      generation,
      previousGeneration,
      trigger,
      reason: options.reason,
    });
    // EVOLVED → STABLE (steady state at the new generation)
    return this._transition(evolved, EvolutionState.STABLE, { reason: "stable-after-advance" });
  }

  // === validation ==========================================================

  /**
   * Validate an evolution record: metadata shape, generation integrity, no key material.
   * Emits VALIDATED. Marks the record FAILED on corruption.
   * @param {string} sessionId
   * @returns {Promise<{ valid: boolean, state: string, reason?: string }>}
   */
  async validateEvolution(sessionId) {
    const record = await this._require(sessionId);
    try {
      validateEvolutionMetadata(record);
    } catch (error) {
      if (error instanceof CorruptedEvolutionMetadataError && record.state !== EvolutionState.FAILED && record.state !== EvolutionState.RETIRED) {
        await this._transition(record, EvolutionState.FAILED, {
          reason: EvolutionFailureReason.CORRUPTED_METADATA,
          event: EvolutionEventType.FAILED,
        });
      }
      return { valid: false, state: EvolutionState.FAILED, reason: EvolutionFailureReason.CORRUPTED_METADATA };
    }
    this.events.emit(EvolutionEventType.VALIDATED, {
      evolutionId: record.evolutionId,
      sessionId: record.sessionId,
      state: record.state,
      generation: record.generation,
    });
    return { valid: true, state: record.state, generation: record.generation };
  }

  /** Recover a FAILED record back to STABLE (e.g. after metadata was repaired). */
  async recover(sessionId) {
    const record = await this._require(sessionId);
    if (record.state !== EvolutionState.FAILED) {
      throw new EvolutionValidationError(`Only a failed evolution can be recovered (state: ${record.state})`, { details: { state: record.state } });
    }
    validateEvolutionMetadata(record);
    return this._transition(record, EvolutionState.STABLE, { reason: "recovered" });
  }

  // === retirement ==========================================================

  /**
   * Retire evolution tracking (the underlying session ended). Terminal. Emits RETIRED.
   * @param {string} sessionId @param {{ reason?: string }} [options]
   * @returns {Promise<object>} public DTO
   */
  async retire(sessionId, options = {}) {
    const record = await this._require(sessionId);
    if (record.state === EvolutionState.RETIRED) return toPublicEvolution(record, { now: this.clock() });
    this.scheduler.cancel(record.sessionId);
    return this._transition(record, EvolutionState.RETIRED, {
      reason: options.reason ?? "session-ended",
      pending: null,
      event: EvolutionEventType.RETIRED,
      audit: createAuditEntry("retired", { at: nowIso(this.clock), reason: options.reason }),
    });
  }

  /** Delete an evolution record entirely (housekeeping). */
  async deleteEvolutionState(sessionId) {
    validateSessionRef(sessionId);
    this.scheduler.cancel(String(sessionId));
    const deleted = await this.evolutions.delete(sessionId);
    return { sessionId: String(sessionId), deleted };
  }

  // === internals ==========================================================

  /** @private Load + require a record by session id (validated). */
  async _require(sessionId) {
    validateSessionRef(sessionId);
    return requireEvolution(await this.evolutions.findBySessionId(sessionId), sessionId);
  }

  /** @private Persist a policy-set change + recomputed policy metadata. */
  async _updatePolicies(record, policies, meta) {
    const at = nowIso(this.clock);
    const next = { ...record, policies };
    const { policyMetadata } = recomputeMetadata(next, { at });
    const updated = await this.evolutions.update(record.sessionId, {
      policies: policies.map(serializePolicy),
      policyMetadata,
      audit: appendAudit(record.audit, createAuditEntry(meta.action, { at, details: { policyId: meta.policyId, policyType: meta.policyType } })),
      updatedAt: at,
    });
    this.events.emit(EvolutionEventType.POLICY_UPDATED, {
      evolutionId: record.evolutionId,
      sessionId: record.sessionId,
      policyId: meta.policyId,
      policyType: meta.policyType,
      details: { count: policies.length },
    });
    return toPublicEvolution(updated, { now: this.clock() });
  }

  /**
   * @private Perform a guarded lifecycle transition, persisting state + history +
   * recomputed metadata. Returns the public DTO, or the raw record if `returnRecord`.
   */
  async _transition(record, toState, options = {}) {
    assertEvolutionTransition(record.state, toState);
    const at = nowIso(this.clock);
    const merged = { ...record, ...(options.patch ?? {}), state: toState };
    const { evolutionMetadata } = recomputeMetadata(merged, { at });
    const patch = {
      state: toState,
      history: [...(record.history ?? []), { from: record.state, to: toState, at, reason: options.reason }],
      evolutionMetadata,
      updatedAt: at,
      ...(options.patch ?? {}),
    };
    if (options.pending !== undefined) patch.pending = options.pending;
    if (options.audit) patch.audit = appendAudit(record.audit, options.audit);
    const updated = await this.evolutions.update(record.sessionId, patch);
    if (options.event) {
      this.events.emit(options.event, {
        evolutionId: record.evolutionId,
        sessionId: record.sessionId,
        previousState: record.state,
        state: toState,
        generation: updated.generation,
        reason: options.reason,
        ...(options.eventExtras ?? {}),
      });
    }
    return options.returnRecord ? updated : toPublicEvolution(updated, { now: this.clock() });
  }
}

/** Keep the custom `evaluate` fn on the in-memory descriptor while normalizing shape. */
function serializePolicyKeepEval(policy) {
  const base = serializePolicy(policy);
  return typeof policy.evaluate === "function" ? { ...base, evaluate: policy.evaluate } : base;
}

/** Build the record's `pending` slot from a scheduler plan. */
function pendingFromPlan(plan) {
  return {
    evolutionId: plan.evolutionId,
    sessionId: plan.sessionId,
    policyId: plan.policyId,
    policyType: plan.policyType,
    trigger: plan.trigger,
    reason: plan.reason,
    scheduledAt: plan.scheduledAt,
    dueAt: plan.dueAt,
    targetGeneration: plan.targetGeneration,
  };
}

const nowIso = (clock) => new Date(clock()).toISOString();
