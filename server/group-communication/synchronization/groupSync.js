/**
 * @module group-communication/synchronization
 *
 * **Group synchronization** — brings a device's group-communication replica up to date after it has
 * been offline: membership changes, metadata edits, key-version rotations (rekey catch-up), and replica
 * advances it missed. It reuses the Layer 9 delta model (compute what's missing → build a deterministic,
 * resumable plan → apply monotonically) scoped to a single group, so it plugs onto the existing
 * synchronization engine rather than reinventing it.
 *
 * A sync plan is an ordered, batchable list of facet UPDATES a reconnecting device applies. Facets sync
 * in a fixed priority order (`key-version` first so the device can decrypt, then `membership`,
 * `metadata`, `replica`), and the plan is PARTIAL-friendly (a `cursor` resumes an interrupted sync).
 *
 * @security A sync plan carries facet names + version ranges + missed-message REFERENCES (ids + key
 * versions) ONLY — never ciphertext or keys. The ciphertext of missed messages is delivered separately
 * over the Layer 8 data plane (resume delivery), not embedded in the plan.
 *
 * Pure functions, no I/O.
 */

import crypto from "node:crypto";
import { GroupSyncFacet, GROUP_COMM_SCHEMA_VERSION } from "../types/types.js";
import { SynchronizationError } from "../errors.js";
import { computeReplicaDelta } from "../replicas/groupCommReplica.js";
import { rekeyCatchUp } from "../key-management/rekey.js";

/** The fixed facet sync order — key first (so the device can decrypt), then state. */
export const FACET_SYNC_ORDER = Object.freeze([GroupSyncFacet.KEY_VERSION, GroupSyncFacet.MEMBERSHIP, GroupSyncFacet.METADATA, GroupSyncFacet.REPLICA]);

/** A deterministic hash of a plan's operations (stable ordering) — for idempotency + resume. */
export function hashSyncPlan(operations) {
  const material = operations.map((o) => `${o.facet}:${o.from}->${o.to}`).join("|");
  return crypto.createHash("sha256").update(`${GroupSyncFacet.REPLICA}|${material}`).digest("hex").slice(0, 32);
}

/**
 * Build a group synchronization plan for a device. Pure. @param {object} params
 * @param {object} params.replica the device's comm replica
 * @param {object} params.authoritative `{ membership, metadata, keyVersion, replica }` — the group's current facet versions
 * @param {Array<{messageId, keyVersion, createdAt}>} [params.missedMessages] messages after the device's cursor (refs only)
 * @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 * @returns {object} the sync plan
 */
export function createGroupSyncPlan(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowIso = new Date(clock()).toISOString();
  const { replica, authoritative } = params;
  if (!replica) throw new SynchronizationError("A replica is required to build a sync plan");
  const delta = computeReplicaDelta(replica, authoritative);

  const operations = [];
  for (const facet of FACET_SYNC_ORDER) {
    const change = delta.facets[facet];
    if (!change) continue;
    const op = { facet, from: change.from, to: change.to };
    if (facet === GroupSyncFacet.KEY_VERSION) op.missedKeyVersions = rekeyCatchUp(change.from, change.to).missedVersions;
    operations.push(op);
  }

  const missedMessages = (params.missedMessages ?? []).map((m) => ({ messageId: m.messageId, keyVersion: m.keyVersion, createdAt: m.createdAt }));

  return {
    planId: idGenerator(),
    groupId: replica.groupId,
    deviceId: replica.deviceId,
    operations,
    missedMessages, // refs only — actual ciphertext resumes over Layer 8
    cursor: 0,
    totalOperations: operations.length,
    upToDate: delta.upToDate && missedMessages.length === 0,
    planHash: hashSyncPlan(operations),
    createdAt: nowIso,
    schemaVersion: GROUP_COMM_SCHEMA_VERSION,
  };
}

/** The operations remaining after a resume cursor (partial synchronization). */
export function remainingSyncOperations(plan, cursor = 0) {
  return (plan.operations ?? []).slice(Math.max(0, cursor));
}

/**
 * Advance a plan's cursor after applying `applied` operations (monotonic). Returns a NEW plan.
 * @throws {SynchronizationError} on a regressing cursor.
 */
export function advanceSyncCursor(plan, applied) {
  const next = (plan.cursor ?? 0) + Math.max(0, applied);
  if (next < (plan.cursor ?? 0)) throw new SynchronizationError("Sync cursor cannot regress");
  return { ...plan, cursor: Math.min(next, plan.totalOperations) };
}

/** Validate a sync plan's shape. @throws {SynchronizationError} */
export function validateSyncPlan(plan) {
  if (!plan || typeof plan !== "object") throw new SynchronizationError("plan must be an object");
  if (!plan.groupId || !plan.deviceId) throw new SynchronizationError("plan is missing groupId/deviceId");
  if (!Array.isArray(plan.operations)) throw new SynchronizationError("plan.operations must be an array");
  return plan;
}
