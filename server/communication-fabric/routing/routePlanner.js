/**
 * @module communication-fabric/routing/routePlanner
 *
 * The **Route Planner** (STEP 7) — turns a decision's primary route into route metadata: the primary
 * route kind, its ordered fallback candidates, and diagnostics recording how the route was derived. This
 * is DETERMINISTIC by design in Sprint 1 — it reads the decision's `primaryRoute` and attaches the static
 * fallback chain; it performs NO network scoring, NO adaptive selection, NO transport optimization
 * (explicitly deferred to Sprint 2). Its output is consumed by the execution planner.
 *
 * @evolution Sprint 2 subclasses / replaces `planRoute` to rank candidates from live connection scores,
 * bandwidth, and battery — the return shape stays identical, so nothing downstream changes.
 */

import { createRoute, fallbacksFor } from "./route.js";
import { FabricEventType } from "../types/types.js";

export class RoutePlanner {
  /** @param {object} [deps] @param {import("../events/events.js").FabricEventBus} [deps.events] */
  constructor(deps = {}) {
    this.events = deps.events ?? null;
    /** Optional per-route fallback overrides (a deployment can restrict/extend the static chain). */
    this.fallbackOverrides = deps.fallbackOverrides ?? null;
  }

  /**
   * Plan the route for a decision + context.
   * @param {import("../types/types.js").CommunicationDecision} decision
   * @param {import("../contexts/communicationContext.js").CommunicationContext} context
   * @returns {object} route metadata (frozen)
   */
  planRoute(decision, context) {
    const primary = decision.primaryRoute;
    const candidates = this.fallbackOverrides?.[primary] ?? fallbacksFor(primary);

    // Sprint 1: candidates are the static fallback chain, filtered by hard constraints only (e.g. a
    // `noBulkQueue` urgent request keeps store-and-forward available but flags it; a durable-queue
    // requirement never removes store-and-forward). No scoring/reordering happens here.
    const diagnostics = {
      strategy: decision.strategyType,
      derivedFrom: "decision.primaryRoute",
      adaptive: false, // Sprint 1 is deterministic; Sprint 2 flips this
      constraints: decision.constraints ?? {},
      availability: context.recipient.availability,
      builtAt: context.execution.createdAt,
    };

    const route = createRoute({ primary, candidates, diagnostics });
    this.events?.emit(FabricEventType.ROUTE_PLANNED, { requestId: decision.requestId, decisionId: decision.decisionId, primary, candidates });
    return route;
  }
}
