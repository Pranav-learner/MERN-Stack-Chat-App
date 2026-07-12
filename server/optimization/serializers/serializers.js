/**
 * @module optimization/serializers
 *
 * Serializers turning the optimizer's internal artifacts into stable, client-facing views. The engine +
 * API return these (never raw internals), so the wire shape is decoupled and every view is control-plane
 * only.
 *
 * @security Views expose ids + classifications + budgets + queue numbers + offsets. No content.
 */

export function toResourceView(snapshot) {
  if (!snapshot) return null;
  return { budgets: snapshot.budgets, constrained: snapshot.constrained, reservations: snapshot.reservations, at: snapshot.at };
}

export function toQoSView(qos) {
  if (!qos) return null;
  return { qosClass: qos.qosClass, lane: qos.lane, weight: qos.weight, mode: qos.mode ?? null, capMultiplier: qos.capMultiplier, deferBackground: qos.deferBackground, policyRefs: qos.policyRefs ?? [], reasons: qos.reasons ?? [] };
}

export function toSchedulingView(scheduling) {
  if (!scheduling) return null;
  return { status: scheduling.status, mode: scheduling.mode, lane: scheduling.lane, position: scheduling.position, window: scheduling.window ?? null, proceed: scheduling.proceed, reason: scheduling.reason ?? null };
}

export function toCoordinationView(coordination) {
  if (!coordination) return null;
  return { primary: coordination.primary, replicas: coordination.replicas, deviceCount: coordination.deviceCount, singleDevice: coordination.singleDevice, plan: coordination.plan };
}

export function toBalanceView(balance) {
  if (!balance) return null;
  return { lanes: balance.lanes, totalDepth: balance.totalDepth, utilization: balance.utilization, backpressure: balance.backpressure, saturatedLanes: balance.saturatedLanes, node: balance.node, recommendations: balance.recommendations };
}

export function toOptimizedPlanView(plan) {
  if (!plan) return null;
  return {
    planId: plan.planId,
    requestId: plan.requestId,
    strategy: plan.strategyType,
    schedulingPlan: plan.schedulingPlan,
    qosPlan: plan.qosPlan,
    resourceAllocationPlan: plan.resourceAllocationPlan,
    coordinationPlan: plan.coordinationPlan,
    fallbackPlan: plan.fallbackPlan,
    timeline: plan.timeline,
    estimatedTotalMs: plan.estimatedTotalMs,
    cost: plan.cost,
    metadata: plan.metadata,
    createdAt: plan.createdAt,
  };
}

/** The full optimization result view (the API's primary payload). */
export function toOptimizationView(result) {
  if (!result) return null;
  return {
    requestId: result.requestId,
    qos: toQoSView(result.qos),
    resources: toResourceView(result.resources),
    scheduling: toSchedulingView(result.scheduling),
    allocation: result.allocation ?? null,
    coordination: toCoordinationView(result.coordination),
    balance: toBalanceView(result.balance),
    optimizedPlan: toOptimizedPlanView(result.optimizedPlan),
    status: result.status,
    proceed: result.proceed,
  };
}
