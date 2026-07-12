/**
 * @module optimization/api
 *
 * The stable **Optimization service facade** the HTTP controller delegates to (STEP 11). Wraps the
 * {@link GlobalOptimizer} with a flat surface: schedule a communication (the full optimization), get the
 * optimized execution plan, get a QoS profile, get a resource allocation, read the scheduler state, drain
 * ready work, and read diagnostics + status. This is the boundary the controller programs against.
 *
 * @security Every method returns a control-plane view (ids + classifications + budgets + queue numbers).
 * Schedule/plan authorize the caller as the sender in the optimizer.
 */

export function createOptimizationApi(optimizer) {
  return {
    /** Full global optimization for a communication (the primary entry point). */
    schedule: (input, opts) => optimizer.schedule(input, opts),
    /** The optimized execution plan (dry run). */
    getExecutionPlan: (input, opts) => optimizer.getExecutionPlan(input, opts),
    /** The QoS profile (dry run). */
    getQoSProfile: (input, opts) => optimizer.getQoSProfile(input, opts),
    /** The resource allocation recommendation (dry run). */
    getResourceAllocation: (input, opts) => optimizer.getResourceAllocation(input, opts),
    /** The current scheduler + workload state. */
    getSchedulerState: () => optimizer.getSchedulerState(),
    /** Drain ready queued work (adaptive dispatch). */
    dispatch: (opts) => optimizer.dispatch(opts),
    /** Optimization diagnostics + audit for a request. */
    diagnostics: ({ requestId }) => optimizer.diagnostics(requestId),
    /** Fabric optimization status / health. */
    status: () => optimizer.status(),
  };
}
