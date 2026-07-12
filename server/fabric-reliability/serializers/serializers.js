/**
 * @module fabric-reliability/serializers
 *
 * Serializers turning the reliability layer's internal artifacts into stable, client-facing views. The
 * manager + API return these (never raw internals), so the wire shape is decoupled and every view is
 * control-plane only.
 *
 * @security Views expose ids + classifications + statuses + numbers. No content.
 */

/** A resilient-operation result view. Carries the underlying operation `result` through unchanged. */
export function toResultView(result) {
  if (!result) return null;
  return {
    operationId: result.operationId,
    kind: result.kind,
    ok: result.ok,
    state: result.state,
    result: result.result ?? null,
    attempts: result.attempts,
    latencyMs: result.latencyMs,
    recovery: result.recovery ?? null,
    degraded: result.degraded ?? null,
    error: result.error ? { code: result.error.code, reason: result.error.reason, failureClass: result.error.failureClass } : null,
  };
}

/** A health view. */
export function toHealthView(health) {
  if (!health) return null;
  return { status: health.status, components: health.components, at: health.at };
}

/** A diagnostics overview view. */
export function toDiagnosticsView(overview) {
  if (!overview) return null;
  return {
    health: toHealthView(overview.health),
    metrics: overview.metrics,
    circuits: overview.circuits,
    bulkheads: overview.bulkheads,
    recovery: overview.recovery,
    alerts: overview.alerts,
  };
}

/** An operation-inspection view. */
export function toOperationView(inspection) {
  if (!inspection) return null;
  return { operationId: inspection.operationId, operation: inspection.operation, audit: inspection.audit };
}
