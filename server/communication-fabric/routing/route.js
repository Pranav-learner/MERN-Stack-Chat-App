/**
 * @module communication-fabric/routing/route
 *
 * The **Route** model + fallback vocabulary (STEP 7). A route describes WHERE a plan step travels — the
 * {@link RouteKind}, the subsystem that owns it, and routing metadata (diagnostics + fallback candidates).
 * Sprint 1 defines the routing ARCHITECTURE only: routes are chosen DETERMINISTICALLY from the selected
 * strategy — there is NO adaptive scoring / network measurement (that is Sprint 2). The fallback list is
 * a static, ordered set of alternatives the execution planner can attach; the orchestrator walks it on
 * failure but never re-scores.
 *
 * @security A route is pure control-plane metadata (kind + subsystem + ids). No content.
 */

import { RouteKind, SubsystemKind } from "../types/types.js";
import { deepFreeze } from "../contexts/communicationContext.js";

/**
 * The default, DETERMINISTIC fallback chain for each primary route. Ordered most-preferred first. Sprint
 * 1 uses these as static alternatives (e.g. a failed direct send falls back to store-and-forward); Sprint
 * 2 replaces the selection with adaptive scoring but keeps this shape.
 * @type {Readonly<Record<string, string[]>>}
 */
export const DEFAULT_FALLBACK_ROUTES = Object.freeze({
  [RouteKind.DIRECT_TRANSPORT]: [RouteKind.RELAYED_TRANSPORT, RouteKind.STORE_AND_FORWARD],
  [RouteKind.RELAYED_TRANSPORT]: [RouteKind.STORE_AND_FORWARD],
  [RouteKind.GROUP_FANOUT]: [RouteKind.STORE_AND_FORWARD],
  [RouteKind.MEDIA_PIPELINE]: [RouteKind.STORE_AND_FORWARD],
  [RouteKind.STORE_AND_FORWARD]: [],
  [RouteKind.SYNC_CHANNEL]: [],
  [RouteKind.LOCAL]: [],
});

/** Which subsystem owns a route kind (used to seed step delegation). */
export const ROUTE_OWNER = Object.freeze({
  [RouteKind.DIRECT_TRANSPORT]: SubsystemKind.MESSAGING,
  [RouteKind.RELAYED_TRANSPORT]: SubsystemKind.MESSAGING,
  [RouteKind.STORE_AND_FORWARD]: SubsystemKind.MESSAGING,
  [RouteKind.GROUP_FANOUT]: SubsystemKind.GROUP,
  [RouteKind.MEDIA_PIPELINE]: SubsystemKind.MEDIA,
  [RouteKind.SYNC_CHANNEL]: SubsystemKind.SYNCHRONIZATION,
  [RouteKind.LOCAL]: SubsystemKind.DELIVERY,
});

/**
 * Build a frozen route-metadata object.
 * @param {object} spec
 * @param {string} spec.primary the primary {@link RouteKind}
 * @param {string[]} [spec.candidates] ordered fallback route kinds
 * @param {object} [spec.diagnostics] how the route was derived
 * @returns {object}
 */
export function createRoute(spec) {
  return deepFreeze({
    primary: spec.primary,
    owner: ROUTE_OWNER[spec.primary] ?? null,
    candidates: [...(spec.candidates ?? [])],
    diagnostics: spec.diagnostics ?? {},
  });
}

/** Resolve the static fallback chain for a route kind. */
export function fallbacksFor(routeKind) {
  return [...(DEFAULT_FALLBACK_ROUTES[routeKind] ?? [])];
}
