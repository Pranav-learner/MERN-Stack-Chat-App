/**
 * @module communication-fabric/coordinators/subsystemCoordinator
 *
 * The **Subsystem Coordinator** (STEP 3 "Coordinate Subsystems") — the thin bridge between a plan step and
 * the registry. It resolves the adapter for a step's subsystem, checks the adapter actually supports the
 * step's action, invokes it, and normalizes the outcome into a uniform `{ ok, result | error }` — so the
 * orchestrator's control flow never touches subsystem specifics. The coordinator contains NO business
 * logic from lower layers; it only routes a step to the right adapter and shapes the result.
 *
 * @security Passes the step (ids + opaque refs) + control-plane context to the adapter — nothing else.
 */

import { SubsystemUnavailableError, SubsystemFailedError, FabricError } from "../errors.js";

export class SubsystemCoordinator {
  /** @param {object} deps @param {import("../registry/subsystemRegistry.js").SubsystemRegistry} deps.registry */
  constructor(deps = {}) {
    if (!deps.registry) throw new Error("SubsystemCoordinator requires a registry");
    this.registry = deps.registry;
  }

  /**
   * Execute one plan step by delegating to its subsystem adapter.
   * @param {object} step a {@link PlanStep}
   * @param {import("../contexts/communicationContext.js").CommunicationContext} context
   * @returns {Promise<{ ok: boolean, result?: any, error?: object }>}
   */
  async run(step, context) {
    let adapter;
    try {
      adapter = this.registry.resolve(step.subsystem);
    } catch (error) {
      return { ok: false, error: toErrorInfo(error) };
    }

    if (adapter.supports && !adapter.supports(step.action)) {
      const err = new SubsystemUnavailableError(`Subsystem "${step.subsystem}" does not support action "${step.action}"`, { details: { kind: step.subsystem, action: step.action } });
      return { ok: false, error: toErrorInfo(err) };
    }

    try {
      const outcome = await adapter.execute(step, context);
      return { ok: outcome?.ok !== false, result: outcome?.result ?? outcome ?? null, adapter: adapter.name };
    } catch (error) {
      const err = error instanceof FabricError ? error : new SubsystemFailedError(`Subsystem "${step.subsystem}" threw`, { details: { kind: step.subsystem, action: step.action, cause: error?.message } });
      return { ok: false, error: toErrorInfo(err) };
    }
  }
}

/**
 * Reduce an error to a control-plane-safe info object (code + reason + a short note + safe details). The
 * human-readable text is stored under `note` (NOT `message`) so it never collides with the no-content
 * scan's forbidden `message` key — a fabric record must not carry a field literally named `message`.
 */
export function toErrorInfo(error) {
  if (error instanceof FabricError) return { code: error.code, reason: error.reason, note: error.message, details: error.details ?? null };
  return { code: "ERR_FABRIC", reason: "internal-error", note: error?.message ?? "unknown error", details: null };
}
