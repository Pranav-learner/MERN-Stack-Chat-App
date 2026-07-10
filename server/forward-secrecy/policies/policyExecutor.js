/**
 * @module forward-secrecy/policies
 *
 * **Policy integration** — the bridge that turns a Sprint 1 evolution *decision* ("this
 * session should evolve now") into a Sprint 2 cryptographic *action* (advance the
 * generation + rotate keys). In Sprint 1 policies only decided WHEN; here, policy
 * execution actually **advances session generations**.
 *
 * Supported drivers:
 *   - **Manual** — an explicit request.
 *   - **Policy** — evaluate the session's evolution policies (time-based, message-count,
 *     security-event, …) and evolve if any fires.
 *   - **Security-triggered** — evolve immediately on a security signal.
 *   - **Scheduled** — evolve the sessions whose deferred evolution is now due.
 *
 * @security The executor performs no cryptography itself — it delegates to the
 * {@link ForwardSecrecyManager}, which owns all key material. It only decides + drives.
 */

import { ForwardSecrecyEventType, EvolutionTrigger } from "../types/types.js";

export class EvolutionPolicyExecutor {
  /**
   * @param {object} deps
   * @param {import("../manager/forwardSecrecyManager.js").ForwardSecrecyManager} deps.forwardSecrecy
   * @param {object} [deps.evolution] a Sprint 1 EvolutionManager (for policy evaluation + scheduling)
   * @param {object} [deps.events] the FS event bus (defaults to the manager's)
   */
  constructor(deps) {
    if (!deps || !deps.forwardSecrecy) throw new Error("EvolutionPolicyExecutor requires { forwardSecrecy }");
    this.fs = deps.forwardSecrecy;
    this.evolution = deps.evolution ?? this.fs.evolution ?? null;
    this.events = deps.events ?? this.fs.events;
  }

  /**
   * Manually evolve a session (explicit request).
   * @param {string} sessionId @param {{ reason?: string, actingUser?: string, sessionStatus?: string }} [options]
   * @returns {Promise<object>} the FS DTO
   */
  async executeManual(sessionId, options = {}) {
    return this.fs.evolve(sessionId, { ...options, trigger: EvolutionTrigger.MANUAL, reason: options.reason ?? "manual" });
  }

  /**
   * Evaluate a session's evolution policies and evolve if any triggers. Requires an
   * injected EvolutionManager.
   * @param {string} sessionId @param {object} [context] evaluation signals (now, messagesSinceLastEvolution, securityEvent, …)
   * @returns {Promise<{ triggered: boolean, evolved: boolean, policy?: object, state?: object }>}
   */
  async executePolicies(sessionId, context = {}) {
    if (!this.evolution) throw new Error("executePolicies requires an evolution manager");
    const outcome = await this.evolution.evaluate(sessionId, context);
    if (!outcome.anyTriggered) return { triggered: false, evolved: false };
    const policy = outcome.triggered[0];
    this.events.emit(ForwardSecrecyEventType.POLICY_TRIGGERED, { sessionId: String(sessionId), reason: policy.reason, details: { policyId: policy.policyId, policyType: policy.type } });
    const state = await this.fs.evolve(sessionId, { trigger: EvolutionTrigger.POLICY, reason: policy.reason ?? policy.type });
    return { triggered: true, evolved: true, policy, state };
  }

  /**
   * Evolve immediately in response to a security event (e.g. suspected compromise).
   * @param {string} sessionId @param {{ securityEvent?: string, reason?: string, actingUser?: string }} [options]
   * @returns {Promise<object>} the FS DTO
   */
  async executeSecurityEvent(sessionId, options = {}) {
    this.events.emit(ForwardSecrecyEventType.POLICY_TRIGGERED, { sessionId: String(sessionId), reason: options.reason ?? options.securityEvent, trigger: EvolutionTrigger.SECURITY_EVENT });
    return this.fs.evolve(sessionId, { ...options, trigger: EvolutionTrigger.SECURITY_EVENT, reason: options.reason ?? options.securityEvent ?? "security-event" });
  }

  /**
   * Evolve a session whose scheduled evolution is due.
   * @param {string} sessionId @param {{ reason?: string }} [options] @returns {Promise<object>}
   */
  async executeScheduled(sessionId, options = {}) {
    return this.fs.evolve(sessionId, { trigger: EvolutionTrigger.SCHEDULED, reason: options.reason ?? "scheduled" });
  }

  /**
   * Run every deferred evolution that is now due on a Sprint 1 {@link EvolutionScheduler}.
   * Each due session is evolved (which also clears its pending schedule via the manager).
   * @param {object} scheduler an EvolutionScheduler @param {{ now?: number }} [options]
   * @returns {Promise<{ ran: number, sessionIds: string[] }>}
   */
  async runDue(scheduler, options = {}) {
    const due = scheduler.due(options.now);
    const sessionIds = [];
    for (const plan of due) {
      try {
        await this.executeScheduled(plan.sessionId, { reason: plan.reason });
        sessionIds.push(plan.sessionId);
      } catch (error) {
        this.events.emit(ForwardSecrecyEventType.EVOLUTION_FAILED, { sessionId: plan.sessionId, reason: error?.code ?? "error" });
      }
    }
    return { ran: sessionIds.length, sessionIds };
  }
}
