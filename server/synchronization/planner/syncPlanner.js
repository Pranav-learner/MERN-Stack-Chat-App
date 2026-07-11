/**
 * @module synchronization/planner
 *
 * The **Synchronization Planner** — turns a {@link module:synchronization/delta delta} into a
 * DETERMINISTIC, prioritized, batched plan of sync operations. The same delta always yields the same
 * plan (same operation ids, same order, same batches — verified by a `deterministicHash`), so a plan
 * can be persisted, resumed, and re-derived across devices without drift.
 *
 * Planning: order categories by priority (device metadata + conversations first, attachments last),
 * batch each category's missing entities into fixed-size operations, estimate the transfer size, and —
 * if the delta exceeds the item cap — produce a PARTIAL plan (the rest syncs in a follow-up session).
 *
 * @security Plans reference entity IDs + versions only — never content.
 *
 * @distributed Determinism is what lets two replicas agree on the same sync plan and lets a paused
 * session resume from a cursor without re-planning.
 */

import crypto from "node:crypto";
import { CATEGORY_PRIORITY, CATEGORY_SIZE_HINT, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE, DEFAULT_MAX_PLAN_ITEMS, SyncOperationState } from "../types/types.js";
import { estimateDeltaBytes } from "../delta/deltaDetector.js";
import { InvalidPlanError } from "../errors.js";

/**
 * Create a deterministic synchronization plan from a delta.
 * @param {import("../types/types.js").SyncDelta} delta
 * @param {{ sessionId: string, batchSize?: number, maxItems?: number, priority?: Object<string, number>, now?: number }} options
 * @returns {object} the sync plan
 */
export function createSyncPlan(delta, options = {}) {
  if (!delta || typeof delta.categories !== "object") throw new InvalidPlanError("createSyncPlan requires a delta");
  const sessionId = options.sessionId;
  if (!sessionId) throw new InvalidPlanError("createSyncPlan requires { sessionId }");
  const batchSize = clampBatch(options.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxItems = options.maxItems ?? DEFAULT_MAX_PLAN_ITEMS;
  const priority = options.priority ?? CATEGORY_PRIORITY;

  // Deterministic category order: priority desc, then category name asc.
  const categories = Object.keys(delta.categories).sort((a, b) => (priority[b] ?? 0) - (priority[a] ?? 0) || (a < b ? -1 : a > b ? 1 : 0));

  const operations = [];
  let plannedItems = 0;
  let estimatedBytes = 0;
  let partial = false;
  let remaining = 0;

  for (const category of categories) {
    // Entity refs are already sorted by the delta detector; keep that order.
    const refs = delta.categories[category].missing ?? [];
    let batchIndex = 0;
    let i = 0;
    while (i < refs.length) {
      if (plannedItems >= maxItems) {
        partial = true;
        remaining += refs.length - i; // this category's remainder spills to a follow-up session
        break;
      }
      const take = Math.min(batchSize, maxItems - plannedItems, refs.length - i);
      const slice = refs.slice(i, i + take);
      const bytes = slice.length * (CATEGORY_SIZE_HINT[category] ?? 512);
      operations.push({
        opId: `${sessionId}:${category}:${batchIndex}`,
        sessionId,
        category,
        priority: priority[category] ?? 0,
        entityRefs: slice,
        itemCount: slice.length,
        batchIndex,
        estimatedBytes: bytes,
        state: SyncOperationState.PENDING,
        retryCount: 0,
      });
      plannedItems += slice.length;
      estimatedBytes += bytes;
      batchIndex++;
      i += take;
    }
  }

  const plan = {
    planId: `plan:${sessionId}`,
    sessionId,
    protocolVersion: "1.0",
    operations,
    ordering: categories,
    totalOperations: operations.length,
    totalItems: delta.totalItems ?? plannedItems + remaining,
    plannedItems,
    remainingItems: remaining,
    partial,
    batchSize,
    estimatedBytes: estimatedBytes || estimateDeltaBytes(delta),
    resumeCursor: 0,
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
    schemaVersion: 1,
  };
  plan.deterministicHash = hashPlan(plan);
  return plan;
}

/** The remaining operations of a plan from its resume cursor (for resuming a paused session). */
export function remainingOperations(plan, cursor = plan.resumeCursor ?? 0) {
  return (plan.operations ?? []).slice(cursor);
}

/** A stable hash over a plan's ordered operation ids + entity refs (proves determinism). */
export function hashPlan(plan) {
  const material = (plan.operations ?? []).map((op) => `${op.opId}|${op.entityRefs.map((r) => `${r.entityId}@${r.version}`).join(",")}`).join("\n");
  return crypto.createHash("sha256").update(material).digest("hex");
}

/** Validate a plan's shape + determinism hash. @throws {InvalidPlanError} */
export function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.operations)) throw new InvalidPlanError("plan is malformed");
  const seen = new Set();
  for (const op of plan.operations) {
    if (typeof op.opId !== "string") throw new InvalidPlanError("plan operation missing opId");
    if (seen.has(op.opId)) throw new InvalidPlanError(`duplicate operation id "${op.opId}"`, { details: { opId: op.opId } });
    seen.add(op.opId);
  }
  if (plan.deterministicHash && plan.deterministicHash !== hashPlan(plan)) throw new InvalidPlanError("plan deterministic hash mismatch (tampered / non-deterministic)");
  return plan;
}

function clampBatch(n) {
  if (!Number.isInteger(n) || n <= 0) throw new InvalidPlanError("batchSize must be a positive integer", { details: { batchSize: n } });
  return Math.min(MAX_BATCH_SIZE, n);
}
