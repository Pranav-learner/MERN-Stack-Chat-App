/**
 * @module group/replicas
 *
 * **Group replica state.** A group is a distributed entity: every device that belongs to it keeps a
 * REPLICA of the group's control plane (membership + metadata + versions). This module builds an
 * immutable REPLICA SNAPSHOT of a group — a compact, deterministic projection a device stores locally
 * and reconciles later. It deliberately mirrors the shape Layer 9's Replica Manager expects so group
 * synchronization (a future sprint) can drop straight onto the existing replication engine.
 *
 * A snapshot holds:
 *  - `membershipSnapshot` — `memberId → { role, state, version }` (counted members + their versions)
 *  - `metadataSnapshot`   — the metadata facet + its version
 *  - `versions`           — the group's full {@link module:group/versions version vector}
 *  - `pendingUpdates`     — locally-queued changes not yet reconciled (for offline edits)
 *  - `syncMetadata`       — last-synced counters + a content fingerprint for cheap divergence checks
 *  - `diagnostics`        — counts + a drift indicator
 *
 * @security A replica carries ids + roles + states + versions + counts ONLY — never message content,
 * ciphertext, or keys. The fingerprint is an opaque digest used to DETECT divergence, not reveal state.
 *
 * @evolution `toReplicationEntities` is the SEAM that maps this snapshot into Layer 9 Sprint 1's
 * `entityId → version` maps, so a future group-sync sprint reuses the replication engine unchanged.
 * Pure functions, no I/O.
 */

import crypto from "node:crypto";
import { GROUP_SCHEMA_VERSION, VersionKind } from "../types/types.js";
import { isActiveState } from "../lifecycle/lifecycle.js";
import { normalizeVersionVector } from "../versions/versionManager.js";

/** Deterministic JSON (sorted keys) so fingerprints are stable across runs + devices. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** An opaque content fingerprint over a replica's material state (divergence detection, not content). */
export function replicaFingerprint(membershipSnapshot, metadataSnapshot, versions) {
  const material = { m: membershipSnapshot, meta: { version: metadataSnapshot?.version ?? 0 }, v: normalizeVersionVector(versions) };
  return crypto.createHash("sha256").update(stableStringify(material)).digest("hex");
}

/**
 * Build the membership projection (`memberId → { role, state, version }`) for a replica. Includes ALL
 * memberships (not just active) so a device can render invited/pending too, but flags counted members.
 */
export function projectMembership(memberships = []) {
  const out = {};
  for (const m of memberships) {
    out[String(m.memberId)] = { role: m.role, state: m.state, version: m.version ?? 1, counted: isActiveState(m.state) };
  }
  return out;
}

/**
 * Build a group replica snapshot. @param {object} params
 * @param {import("../types/types.js").Group} params.group @param {import("../types/types.js").Membership[]} params.memberships
 * @param {string} [params.replicaId] @param {object} [params.pendingUpdates] @param {() => number} [params.clock]
 * @param {() => string} [params.idGenerator]
 */
export function buildReplicaState(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowIso = new Date(clock()).toISOString();
  const group = params.group;
  const memberships = params.memberships ?? [];
  const membershipSnapshot = projectMembership(memberships);
  const metadataSnapshot = { ...(group.metadata ?? {}) };
  const versions = normalizeVersionVector(group.versions);
  const counted = Object.values(membershipSnapshot).filter((m) => m.counted).length;
  const fingerprint = replicaFingerprint(membershipSnapshot, metadataSnapshot, versions);
  return {
    replicaId: params.replicaId ?? idGenerator(),
    groupId: String(group.groupId),
    replicaVersion: versions.replica,
    membershipSnapshot,
    metadataSnapshot,
    versions,
    pendingUpdates: params.pendingUpdates ?? [],
    syncMetadata: {
      lastBuiltAt: nowIso,
      lastSyncedGroupVersion: versions.group,
      fingerprint,
    },
    diagnostics: {
      totalMembers: Object.keys(membershipSnapshot).length,
      countedMembers: counted,
      pendingUpdates: (params.pendingUpdates ?? []).length,
      drift: 0,
    },
    createdAt: nowIso,
    updatedAt: nowIso,
    schemaVersion: GROUP_SCHEMA_VERSION,
  };
}

/**
 * Compare a stored replica against a freshly-built one — returns whether they diverge + the drift
 * (facet-version delta on the aggregate `group` counter). Cheap: compares fingerprints first.
 */
export function diffReplica(stored, fresh) {
  if (!stored) return { diverged: true, drift: fresh?.versions?.group ?? 0, reason: "no-local-replica" };
  const diverged = stored.syncMetadata?.fingerprint !== fresh.syncMetadata?.fingerprint;
  const drift = Math.abs((fresh.versions?.group ?? 0) - (stored.versions?.group ?? 0));
  return { diverged, drift, reason: diverged ? "fingerprint-mismatch" : "in-sync" };
}

/**
 * SEAM — map a replica snapshot into Layer 9 Sprint 1's `entityId → version` maps so a FUTURE group-sync
 * sprint reuses the replication engine. Produces `{ membership: {...}, metadata: {...} }` version maps.
 * Inert this sprint (no sync is performed).
 */
export function toReplicationEntities(snapshot) {
  const membership = {};
  for (const [memberId, m] of Object.entries(snapshot.membershipSnapshot ?? {})) membership[memberId] = m.version;
  return {
    [VersionKind.MEMBERSHIP]: membership,
    [VersionKind.METADATA]: { [snapshot.groupId]: snapshot.metadataSnapshot?.version ?? 1 },
  };
}
