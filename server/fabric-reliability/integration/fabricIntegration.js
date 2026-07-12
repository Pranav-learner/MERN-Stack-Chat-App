/**
 * @module fabric-reliability/integration/fabricIntegration
 *
 * **Production integration** — wraps the frozen Communication Fabric API (Sprint 1, already made
 * intelligent by Sprint 2 + globally optimized by Sprint 3) with the reliability manager, WITHOUT
 * modifying it. `createReliableFabric` returns a drop-in replacement facade whose `execute` runs through
 * `reliabilityManager.run("communication-execute", …)` — gaining circuit breaking, bulkheads, timeouts,
 * retries, recovery, graceful degradation, metrics, tracing, and an audit trail. The other fabric methods
 * pass through unchanged (they are read-only / dry-run and don't need the resilient wrapper, though a
 * deployment may wrap them too).
 *
 * @security Pure control-plane wrapping; the reliability layer reads the same operation metadata.
 */

import { FabricOperationKind } from "../types/types.js";

/**
 * Wrap a Communication Fabric API with reliability.
 * @param {object} deps
 * @param {object} deps.fabricApi the frozen Sprint-1 fabric API (`execute`, `plan`, …)
 * @param {import("../manager/reliabilityManager.js").FabricReliabilityManager} deps.reliabilityManager
 * @param {(request:object)=>string} [deps.compartmentOf] map a request to a bulkhead compartment (default: by media/group)
 * @returns {object} a reliable fabric facade
 */
export function createReliableFabric(deps = {}) {
  if (!deps.fabricApi || !deps.reliabilityManager) throw new Error("createReliableFabric requires { fabricApi, reliabilityManager }");
  const { fabricApi, reliabilityManager } = deps;
  const compartmentOf = deps.compartmentOf ?? defaultCompartment;

  return {
    /** Resilient execute — the production entry point. */
    async execute(request, opts = {}) {
      const result = await reliabilityManager.run(FabricOperationKind.COMMUNICATION_EXECUTE, () => fabricApi.execute(request, opts), {
        compartment: compartmentOf(request),
        callerId: opts.callerId,
        ownerId: opts.callerId ?? request?.senderId,
        idempotencyKey: request?.requestId,
        throwOnFail: opts.throwOnFail ?? false,
      });
      return result;
    },

    // read-only / dry-run pass-throughs (unchanged contract)
    plan: (request, opts) => fabricApi.plan(request, opts),
    buildContext: (request) => fabricApi.buildContext(request),
    evaluatePolicies: (request) => fabricApi.evaluatePolicies(request),
    getStrategy: (request, opts) => fabricApi.getStrategy(request, opts),
    getExecutionPlan: (request, opts) => fabricApi.getExecutionPlan(request, opts),
    decisionDiagnostics: (args) => fabricApi.decisionDiagnostics(args),
    health: () => fabricApi.health(),
    registerSubsystem: (adapter) => fabricApi.registerSubsystem(adapter),

    /** Direct access to the reliability manager (diagnostics / health / metrics). */
    reliability: reliabilityManager,
  };
}

/** Default compartment mapping — isolate media (heavy) from group (fan-out) from ordinary messaging. */
function defaultCompartment(request) {
  if (request?.mediaType && request.mediaType !== "none") return "media";
  if (request?.groupId) return "group";
  if (request?.type === "synchronization") return "sync";
  return "messaging";
}
