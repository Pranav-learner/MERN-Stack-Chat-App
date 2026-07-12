/**
 * @module communication-fabric/api
 *
 * The stable **Communication Fabric service facade** the HTTP controller delegates to (STEP 11). It wraps
 * the {@link CommunicationFabricManager} with a flat surface: execute a communication (the single entry
 * point), build a context, evaluate policies, get a strategy/decision, get an execution plan, read
 * decision diagnostics, and read fabric health. This is the boundary application code + the controller
 * program against — never the manager internals.
 *
 * @security Every method returns a control-plane view (ids + classifications + statuses). Execution +
 * decision endpoints authorize the caller as the sender in the manager.
 */

export function createFabricApi(manager) {
  return {
    /** The single entry point — execute a communication end-to-end. */
    execute: (request, opts) => manager.execute(request, opts),
    /** Plan-only (dry run) — decision + plan, no orchestration. */
    plan: (request, opts) => manager.execute(request, { ...opts, dryRun: true }),

    /** Build the immutable context for a request. */
    buildContext: (request) => manager.buildContext(request),
    /** Evaluate policies for a request. */
    evaluatePolicies: (request) => manager.evaluatePolicies(request),
    /** Get the decision (strategy + route) without executing. */
    getStrategy: (request, opts) => manager.getDecision(request, opts),
    /** Get the full execution plan without executing. */
    getExecutionPlan: (request, opts) => manager.getExecutionPlan(request, opts),
    /** Decision diagnostics for a request. */
    decisionDiagnostics: ({ requestId }) => manager.decisionDiagnostics(requestId),
    /** Fabric health. */
    health: () => manager.health(),

    /** Register a subsystem adapter (wiring). */
    registerSubsystem: (adapter) => manager.registerSubsystem(adapter),
  };
}
