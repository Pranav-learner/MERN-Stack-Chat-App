/**
 * @module session-evolution/schedulers
 *
 * The **Evolution Scheduler** — scheduling infrastructure for evolution. It evaluates a
 * record's policies against a context, detects triggers, and holds *deferred* and
 * *pending* evolutions in an in-memory registry keyed by session id. It supports
 * cancellation and reports which deferred evolutions are now due.
 *
 * @important Sprint 1 does **NOT execute** evolution. The scheduler decides WHEN an
 * evolution should occur and parks the intent; a future Layer 5 sprint will attach the
 * automatic-rekeying executor to {@link EvolutionScheduler#due}. No keys move here.
 *
 * @security Pure decision + bookkeeping. No cryptography, no key material.
 */

import { evaluatePolicies } from "../policies/policies.js";
import { EvolutionTrigger } from "../types/types.js";

/**
 * @typedef {object} SchedulePlan
 * @property {string} sessionId @property {string} evolutionId
 * @property {number} targetGeneration @property {string} trigger @property {string} [reason]
 * @property {string} [policyId] @property {string} [policyType]
 * @property {string} scheduledAt ISO @property {string|null} dueAt ISO (null = due immediately)
 */

export class EvolutionScheduler {
  /** @param {{ clock?: () => number }} [options] */
  constructor(options = {}) {
    this._clock = options.clock ?? (() => Date.now());
    /** @type {Map<string, SchedulePlan>} sessionId -> pending plan */
    this._pending = new Map();
  }

  // === evaluation (pure) ===================================================

  /**
   * Evaluate a record's policies against a context and detect triggers.
   * @param {object} state the evolution record
   * @param {object} [context]
   * @returns {{ results: object[], triggered: object[], anyTriggered: boolean }}
   */
  evaluate(state, context = {}) {
    return evaluatePolicies(state, { now: this._clock(), ...context });
  }

  /**
   * The FIRST triggered policy for a record (or null) — the one that would drive the
   * next evolution.
   * @param {object} state @param {object} [context]
   * @returns {{ policyId: string, type: string, reason?: string }|null}
   */
  detectTrigger(state, context = {}) {
    const { triggered } = this.evaluate(state, context);
    return triggered.length ? triggered[0] : null;
  }

  // === registry (deferred / pending) =======================================

  /**
   * Register a deferred or immediately-pending evolution for a session. Overwrites any
   * existing plan for the same session (one queued evolution at a time). Does NOT
   * execute anything.
   * @param {object} params
   * @param {string} params.sessionId @param {string} params.evolutionId
   * @param {number} params.targetGeneration
   * @param {string} [params.trigger=EvolutionTrigger.SCHEDULED]
   * @param {string} [params.reason] @param {string} [params.policyId] @param {string} [params.policyType]
   * @param {number} [params.dueInMs] defer by this many ms (omit / 0 = due now)
   * @param {string|null} [params.dueAt] explicit ISO due time (overrides dueInMs)
   * @returns {SchedulePlan}
   */
  schedule(params) {
    const now = this._clock();
    const dueAt =
      params.dueAt !== undefined
        ? params.dueAt
        : params.dueInMs
          ? new Date(now + params.dueInMs).toISOString()
          : null;
    const plan = {
      sessionId: String(params.sessionId),
      evolutionId: params.evolutionId,
      targetGeneration: params.targetGeneration,
      trigger: params.trigger ?? EvolutionTrigger.SCHEDULED,
      reason: params.reason,
      policyId: params.policyId,
      policyType: params.policyType,
      scheduledAt: new Date(now).toISOString(),
      dueAt,
    };
    this._pending.set(plan.sessionId, plan);
    return { ...plan };
  }

  /** The pending plan for a session, or null. */
  getPending(sessionId) {
    const plan = this._pending.get(String(sessionId));
    return plan ? { ...plan } : null;
  }

  /** Whether a session has a pending plan. */
  hasPending(sessionId) {
    return this._pending.has(String(sessionId));
  }

  /** Cancel (remove) a session's pending plan. @returns {boolean} whether one existed. */
  cancel(sessionId) {
    return this._pending.delete(String(sessionId));
  }

  /** All pending plans (copies). */
  listPending() {
    return [...this._pending.values()].map((p) => ({ ...p }));
  }

  /**
   * Deferred plans that are now due (`dueAt` null or ≤ now). A future sprint feeds
   * these to an executor; Sprint 1 only reports them.
   * @param {number} [now] @returns {SchedulePlan[]}
   */
  due(now = this._clock()) {
    return this.listPending().filter((p) => p.dueAt === null || new Date(p.dueAt).getTime() <= now);
  }

  /** Remove every pending plan. */
  clear() {
    this._pending.clear();
  }

  /** Number of pending plans. */
  get size() {
    return this._pending.size;
  }
}
