/**
 * @module communication-fabric/registry/subsystemRegistry
 *
 * The **Subsystem Registry** (STEP 9) — the Fabric's service-discovery table. Lower layers (messaging,
 * media, synchronization, group, connectivity, presence, delivery) and FUTURE ones (voice, video) are
 * registered here as adapters keyed by {@link SubsystemKind}, with NO hard import. The orchestrator asks
 * the registry for the adapter a plan step needs; if none is registered, the step is handled per its
 * `required` flag (a required step with no adapter fails the execution; an optional one is skipped).
 *
 * This is the seam that lets the Fabric "make communication decisions while allowing every subsystem to
 * remain independent": a new communication system plugs in by registering an adapter — the Fabric,
 * manager, decision engine, and strategies never change.
 *
 * @security The registry stores adapters (kind + actions + handler) — never subsystem internals, keys, or
 * content.
 */

import { createRecordingAdapter } from "./subsystemAdapter.js";
import { SubsystemUnavailableError } from "../errors.js";
import { ALL_SUBSYSTEM_KINDS } from "../types/types.js";

const KIND_SET = new Set(ALL_SUBSYSTEM_KINDS);

export class SubsystemRegistry {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.autoRecord] when true (default), a missing subsystem resolves to a safe
   *   recording adapter instead of throwing — so a foundation deployment still produces a complete,
   *   inspectable execution. Set false to make missing subsystems hard failures.
   */
  constructor(opts = {}) {
    /** @type {Map<string, object>} */
    this._byKind = new Map();
    this._order = [];
    this.autoRecord = opts.autoRecord ?? true;
  }

  /** Register (or replace) a subsystem adapter. @returns {this} */
  register(adapter) {
    if (!adapter || !KIND_SET.has(adapter.kind)) throw new SubsystemUnavailableError(`Cannot register adapter for unknown kind "${adapter?.kind}"`);
    if (typeof adapter.execute !== "function") throw new SubsystemUnavailableError(`Adapter for "${adapter.kind}" has no execute()`);
    if (!this._byKind.has(adapter.kind)) this._order.push(adapter.kind);
    this._byKind.set(adapter.kind, adapter);
    return this;
  }

  /** Is a real adapter registered for this kind? (auto-record fallbacks are NOT counted here) */
  has(kind) {
    return this._byKind.has(kind);
  }

  /** The registered subsystem kinds, in registration order. */
  kinds() {
    return [...this._order];
  }

  /**
   * Resolve the adapter for a kind. Falls back to a recording adapter when `autoRecord` is on and no real
   * adapter is registered; otherwise throws.
   * @param {string} kind @returns {object} adapter
   * @throws {SubsystemUnavailableError}
   */
  resolve(kind) {
    const adapter = this._byKind.get(kind);
    if (adapter) return adapter;
    if (this.autoRecord) return createRecordingAdapter({ kind });
    throw new SubsystemUnavailableError(`No adapter registered for subsystem "${kind}"`, { details: { kind } });
  }

  /** A control-plane snapshot of registered subsystems (diagnostics / health). */
  describe() {
    return this._order.map((kind) => {
      const a = this._byKind.get(kind);
      return { kind, name: a.name, actions: a.actions, metadata: a.metadata ?? {} };
    });
  }
}

/** Build an empty registry (auto-record on). Adapters are registered by the deployment/controller. */
export function createSubsystemRegistry(opts = {}) {
  return new SubsystemRegistry(opts);
}
