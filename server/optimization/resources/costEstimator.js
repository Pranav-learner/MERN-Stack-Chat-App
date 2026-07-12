/**
 * @module optimization/resources/costEstimator
 *
 * Estimates the ABSTRACT resource cost of one communication from its Sprint-1 context — bandwidth, cpu,
 * memory, storage, connection, transfer, and execution UNITS. It reads only control-plane descriptors
 * (declared payload size, media type, conversation shape, fan-out), never bytes, and produces UNITS the
 * Global Resource Manager accounts against its budgets. This is deliberately simple + deterministic (no
 * probing / measurement); Sprint 4 can refine the model without changing the interface.
 *
 * @security Reads declared sizes + classifications only. No content.
 */

import { deepFreeze, MediaType, ConversationType } from "../_fabric.js";

const KB = 1024;

/**
 * Estimate the resource cost of a communication.
 * @param {object} context Sprint-1 context (or `{ raw }`)
 * @param {object} [override] partial cost override (wins per-field)
 * @returns {import("../types/types.js").ResourceCost} frozen cost
 */
export function estimateCost(context, override = null) {
  const raw = context.raw ?? context;
  const sizeBytes = raw.media?.payloadRef?.size ?? raw.media?.size ?? 0;
  const sizeKB = sizeBytes > 0 ? Math.ceil(sizeBytes / KB) : 1;
  const isMedia = raw.media?.type != null && raw.media.type !== MediaType.NONE;
  const fanout = raw.conversation?.type === ConversationType.GROUP ? raw.group?.memberHint ?? raw.recipient?.count ?? 1 : Math.max(1, raw.recipient?.count ?? 1);

  const cost = {
    bandwidth: sizeKB * fanout,
    cpu: (isMedia ? 5 : 1) * Math.max(1, Math.ceil(fanout / 10)),
    memory: sizeKB,
    storage: isMedia ? sizeKB : 0,
    connection: fanout,
    transfer: isMedia ? Math.max(1, Math.ceil(sizeKB / 256)) : 1,
    execution: 1,
  };
  if (override) for (const [k, v] of Object.entries(override)) if (typeof v === "number" && v >= 0) cost[k] = v;
  return deepFreeze(cost);
}

/** Sum two cost objects (used to aggregate a batch's total cost). */
export function addCost(a, b) {
  const out = {};
  for (const k of ["bandwidth", "cpu", "memory", "storage", "connection", "transfer", "execution"]) out[k] = (a?.[k] ?? 0) + (b?.[k] ?? 0);
  return out;
}
