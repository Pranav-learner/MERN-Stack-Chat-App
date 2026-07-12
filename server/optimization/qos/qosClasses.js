/**
 * @module optimization/qos/qosClasses
 *
 * QoS class helpers — the pure mapping between {@link Priority}, {@link QoSClass}, queue lanes, and
 * fair-scheduling weights. Kept separate from the {@link QoSManager} so the mapping is trivially testable
 * and a deployment can reason about it without the manager.
 */

import { QoSClass, QOS_RANK, QOS_LANE, DEFAULT_QOS_WEIGHTS, Priority } from "../types/types.js";

/** The base QoS class for a communication priority (before policy adjustment). */
export function baseClassFor(priority) {
  switch (priority) {
    case Priority.URGENT:
      return QoSClass.CRITICAL;
    case Priority.HIGH:
      return QoSClass.HIGH;
    case Priority.LOW:
      return QoSClass.BACKGROUND;
    default:
      return QoSClass.NORMAL;
  }
}

/** The queue lane for a QoS class. */
export function laneFor(qosClass) {
  return QOS_LANE[qosClass] ?? QOS_LANE.normal;
}

/** The fair-scheduling weight for a QoS class (from a weight table). */
export function weightFor(qosClass, weights = DEFAULT_QOS_WEIGHTS) {
  return weights[qosClass] ?? weights.normal ?? 1;
}

/** Compare two QoS classes by rank (positive if a > b). */
export function compareClasses(a, b) {
  return (QOS_RANK[a] ?? 0) - (QOS_RANK[b] ?? 0);
}

/** The higher-ranked of two classes (used to enforce a CRITICAL floor). */
export function maxClass(a, b) {
  return compareClasses(a, b) >= 0 ? a : b;
}
