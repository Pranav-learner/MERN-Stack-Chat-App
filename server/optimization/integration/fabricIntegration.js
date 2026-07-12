/**
 * @module optimization/integration/fabricIntegration
 *
 * **Sprint-1 ↔ Sprint-3 integration** — the glue that makes the existing Communication Fabric globally
 * optimized WITHOUT redesigning it. It returns the single optional dep the frozen `CommunicationFabricManager`
 * accepts as its Sprint-3 seam: an `executionHook`.
 *
 * The hook is consulted between planning and orchestration. It runs the {@link GlobalOptimizer} over the
 * already-built context + execution plan and returns `{ proceed, status, scheduling }`. When the optimizer
 * schedules the communication IMMEDIATE, `proceed = true` and the Fabric orchestrates now. When it is
 * DEFERRED / QUEUED / BACKGROUND (QoS + resource pressure + policy), `proceed = false` and the Fabric
 * returns a deferred result — the optimizer holds it in its scheduler for a later `dispatch()`.
 *
 * Spread the result into the manager: `new CommunicationFabricManager({ ...repo, ...createFabricOptimizationIntegration({ optimizer }) })`.
 *
 * @security Pure control-plane wiring; the hook reads the same metadata the Fabric already holds.
 */

/**
 * Build the Fabric-facing `executionHook` around a {@link GlobalOptimizer}.
 * @param {object} deps @param {import("../manager/globalOptimizer.js").GlobalOptimizer} deps.optimizer
 * @returns {{ executionHook: (args: object) => Promise<object> }}
 */
export function createFabricOptimizationIntegration(deps = {}) {
  if (!deps.optimizer) throw new Error("createFabricOptimizationIntegration requires an optimizer");
  const optimizer = deps.optimizer;

  const executionHook = async ({ context, decision, plan }) => {
    const raw = context.raw ?? context;
    // reconstruct the optimizer input from the already-built context (no re-normalization of a raw request)
    const input = {
      requestId: raw.execution?.requestId ?? decision?.requestId,
      type: raw.type,
      senderId: raw.conversation?.senderId,
      recipients: raw.recipient?.ids ?? [],
      groupId: raw.group?.groupId ?? undefined,
      conversationId: raw.conversation?.conversationId ?? undefined,
      conversationType: raw.conversation?.type,
      mediaType: raw.media?.type,
      priority: raw.transport?.priority,
      payloadRef: raw.media?.payloadRef ?? undefined,
    };
    const result = await optimizer.optimize(input, { context, executionPlan: plan, allowServer: true });
    return { proceed: result.proceed, status: result.status, scheduling: result.scheduling };
  };

  return { executionHook, optimizer };
}
