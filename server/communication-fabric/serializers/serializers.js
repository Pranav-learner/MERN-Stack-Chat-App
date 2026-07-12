/**
 * @module communication-fabric/serializers
 *
 * Serializers that turn the Fabric's internal value objects into stable, client-facing views. The manager
 * + API return these (never the raw internals), so the wire shape is decoupled from internal
 * representation and every view is guaranteed control-plane only.
 *
 * @security Views expose ids + classifications + counts + statuses. The no-content invariant is upheld by
 * construction — nothing here reads a payload field.
 */

/** A compact decision view for clients (the "how" of a communication). */
export function toDecisionView(decision) {
  if (!decision) return null;
  return {
    decisionId: decision.decisionId,
    requestId: decision.requestId,
    strategy: decision.strategyType,
    route: decision.primaryRoute,
    subsystems: decision.subsystems,
    confidence: decision.confidence,
    reasons: decision.reasons,
    policyRefs: decision.policyRefs,
    constraints: decision.constraints,
    createdAt: decision.createdAt,
  };
}

/** A context view (the assembled facets), used by the buildContext endpoint + diagnostics. */
export function toContextView(context) {
  if (!context) return null;
  const raw = context.raw ?? context;
  return {
    requestId: raw.execution?.requestId,
    type: raw.type,
    conversation: raw.conversation,
    group: raw.group,
    media: raw.media,
    recipient: raw.recipient,
    synchronization: raw.synchronization,
    security: raw.security,
    transport: raw.transport,
    metadata: raw.metadata,
    diagnostics: raw.diagnostics,
  };
}

/** An execution-plan view (ordered steps + fallbacks + routing). */
export function toPlanView(plan) {
  if (!plan) return null;
  return {
    planId: plan.planId,
    requestId: plan.requestId,
    decisionId: plan.decisionId,
    strategy: plan.strategyType,
    steps: plan.steps.map((s) => ({ stepId: s.stepId, subsystem: s.subsystem, action: s.action, route: s.route, required: s.required, dependsOn: s.dependsOn })),
    fallbacks: Object.fromEntries(Object.entries(plan.fallbacks ?? {}).map(([k, v]) => [k, v.map((f) => ({ route: f.route, subsystem: f.subsystem }))])),
    routing: plan.routing,
    createdAt: plan.createdAt,
  };
}

/** An execution result view (status + per-step ledger + timing). */
export function toExecutionView(snapshot) {
  if (!snapshot) return null;
  return {
    requestId: snapshot.requestId,
    planId: snapshot.planId,
    decisionId: snapshot.decisionId,
    strategy: snapshot.strategyType,
    status: snapshot.status,
    durationMs: snapshot.durationMs,
    steps: snapshot.steps.map((s) => ({ stepId: s.stepId, subsystem: s.subsystem, action: s.action, route: s.route, status: s.status, viaFallback: s.viaFallback, error: s.error ? { code: s.error.code, reason: s.error.reason } : null })),
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
  };
}

/** The full "execute communication" result (decision + plan + execution) the API returns. */
export function toResultView({ decision, plan, execution, context }) {
  return {
    requestId: decision?.requestId ?? context?.requestId ?? null,
    decision: toDecisionView(decision),
    plan: toPlanView(plan),
    execution: toExecutionView(execution),
    status: execution?.status ?? null,
  };
}
