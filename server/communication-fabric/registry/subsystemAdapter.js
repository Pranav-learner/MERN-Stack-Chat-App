/**
 * @module communication-fabric/registry/subsystemAdapter
 *
 * The **Subsystem Adapter** contract (STEP 9). An adapter is the ONLY thing the Fabric knows about a lower
 * layer: it declares a `kind` ({@link SubsystemKind}), the `actions` it can perform, and an async
 * `execute(step, context)` that delegates a plan step to the real subsystem. The Fabric NEVER imports a
 * subsystem directly — a deployment builds an adapter that closes over the subsystem's frozen facade and
 * registers it. This is what keeps the Fabric independent of transport / crypto / media / sync
 * implementations while still orchestrating them.
 *
 * Two ready-made builders are provided:
 *   - `createSubsystemAdapter({ kind, name, actions, handler })` — wrap a real subsystem facade.
 *   - `createRecordingAdapter({ kind, actions })` — a safe, side-effect-free adapter that just records the
 *     delegation (the Fabric's default when a real subsystem is not wired, and the tests' stub).
 *
 * @security An adapter receives a plan step (ids + opaque refs) + the control-plane context. It must not
 * be handed — and the Fabric never provides — plaintext or key material.
 */

import { SubsystemFailedError } from "../errors.js";
import { ALL_SUBSYSTEM_KINDS } from "../types/types.js";

const KIND_SET = new Set(ALL_SUBSYSTEM_KINDS);

/**
 * Wrap a real subsystem facade as an adapter.
 * @param {object} spec
 * @param {string} spec.kind one of {@link SubsystemKind}
 * @param {string} [spec.name] human name (default = kind)
 * @param {string[]} [spec.actions] the actions this adapter can perform (default: accepts any)
 * @param {(step: object, context: object) => Promise<any>} spec.handler the delegation
 * @param {object} [spec.metadata] non-secret capability metadata
 * @returns {object} adapter
 */
export function createSubsystemAdapter(spec) {
  if (!KIND_SET.has(spec.kind)) throw new Error(`Unknown subsystem kind "${spec.kind}"`);
  if (typeof spec.handler !== "function") throw new Error(`Adapter for "${spec.kind}" requires a handler function`);
  const actions = spec.actions ? new Set(spec.actions) : null;
  return {
    kind: spec.kind,
    name: spec.name ?? spec.kind,
    actions: spec.actions ? [...spec.actions] : null,
    metadata: spec.metadata ?? {},
    supports(action) {
      return actions == null || actions.has(action);
    },
    async execute(step, context) {
      try {
        const result = await spec.handler(step, context);
        return { ok: true, result: result ?? null };
      } catch (error) {
        // Normalize any subsystem throw into a fabric-typed failure (never leak internals).
        throw new SubsystemFailedError(`Subsystem "${spec.kind}" failed on action "${step.action}"`, {
          details: { kind: spec.kind, action: step.action, stepId: step.stepId, cause: error?.message },
        });
      }
    },
  };
}

/**
 * A safe adapter that performs NO side effects — it records the delegation + echoes the step. This is the
 * Fabric's default for an un-wired subsystem (so a foundation deployment still produces a complete,
 * inspectable execution) and the tests' stub. A recording adapter can be told to fail (for fallback
 * tests) by ACTION (`failOn`), by ROUTE (`failRoutes` — lets a fallback via another route succeed), or
 * unconditionally (`alwaysFail`).
 * @param {object} spec @param {string} spec.kind @param {string[]} [spec.actions]
 * @param {string[]} [spec.failOn] @param {string[]} [spec.failRoutes] @param {boolean} [spec.alwaysFail]
 */
export function createRecordingAdapter(spec) {
  const failOn = spec.failOn ? new Set(spec.failOn) : null;
  const failRoutes = spec.failRoutes ? new Set(spec.failRoutes) : null;
  const calls = [];
  const adapter = createSubsystemAdapter({
    kind: spec.kind,
    name: spec.name ?? `recording:${spec.kind}`,
    actions: spec.actions,
    metadata: { recording: true },
    handler: async (step, _context) => {
      calls.push({ stepId: step.stepId, action: step.action, route: step.route, viaFallback: step.params?.viaFallback ?? null });
      if (spec.alwaysFail || failOn?.has(step.action) || failRoutes?.has(step.route)) throw new Error(`recording adapter forced failure (action "${step.action}", route "${step.route}")`);
      return { recorded: true, action: step.action, route: step.route };
    },
  });
  adapter.calls = calls; // inspectable in tests
  return adapter;
}
