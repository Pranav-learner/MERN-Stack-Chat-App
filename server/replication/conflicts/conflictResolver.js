/**
 * @module replication/conflicts/resolver
 *
 * **Conflict resolution.** Given a detected conflict (two concurrent divergent version records for one
 * entity), pick a deterministic winner according to a CONFIGURABLE, per-category policy:
 *
 * - **last-write-wins** — the record with the newest `updatedAt` (ties broken by the higher
 *   `writerReplicaId`, so it is deterministic — never a coin flip).
 * - **server-authority** — the record written by the designated authoritative replica wins; if neither
 *   is the authority, it falls back to last-write-wins.
 * - **merge** — delegate to the {@link module:replication/merge merge engine} for a lossless merge.
 * - **custom** — an injected resolver decides (a deployment extension point).
 *
 * Every resolution yields a winner + an AUDIT entry (policy, reason, versions) — never content.
 *
 * @distributed Resolution is deterministic so every replica that resolves the same conflict reaches the
 * same winner independently — the core requirement for eventual consistency without a coordinator.
 */

import { ConflictPolicy, DEFAULT_CATEGORY_POLICY, ReplicationFailureReason } from "../types/types.js";
import { mergeRecords } from "../merge/mergeEngine.js";
import { UnresolvedConflictError, ReplicationValidationError } from "../errors.js";

export class ConflictResolver {
  /**
   * @param {object} [config]
   * @param {Object<string, string>} [config.policies] per-category {@link ConflictPolicy} overrides
   * @param {string} [config.defaultPolicy] fallback policy
   * @param {string} [config.authorityReplicaId] the authoritative replica for server-authority
   * @param {Object<string, Function>} [config.customResolvers] category → `(conflict) => EntityVersion`
   */
  constructor(config = {}) {
    this.policies = { ...(config.policies ?? {}) };
    // null (not LWW) so an unset request-default falls through to the per-category default below.
    this.defaultPolicy = config.defaultPolicy ?? null;
    this.authorityReplicaId = config.authorityReplicaId ?? null;
    this.customResolvers = { ...(config.customResolvers ?? {}) };
  }

  /**
   * The effective policy for a category. Precedence: a per-call override > an explicit per-category
   * policy > an explicit request-wide default > the category's built-in default > last-write-wins. An
   * EXPLICIT request policy therefore wins over the built-in category default.
   */
  policyFor(category, override) {
    return override ?? this.policies[category] ?? this.defaultPolicy ?? DEFAULT_CATEGORY_POLICY[category] ?? ConflictPolicy.LAST_WRITE_WINS;
  }

  /**
   * Resolve one conflict. @param {{ category, entityId, source, target }} conflict
   * @param {{ policy?: string, now?: string, authorityReplicaId?: string }} [options]
   * @returns {{ winner: object, policy: string, reason: string, resolvedAt: string }}
   */
  resolve(conflict, options = {}) {
    const { category, source, target } = conflict;
    const policy = this.policyFor(category, options.policy);
    const resolvedAt = options.now ?? new Date().toISOString();

    switch (policy) {
      case ConflictPolicy.LAST_WRITE_WINS: {
        const winner = lwwWinner(source, target);
        return { winner, policy, reason: "newest-updatedAt", resolvedAt };
      }
      case ConflictPolicy.SERVER_AUTHORITY: {
        const authority = options.authorityReplicaId ?? this.authorityReplicaId;
        if (authority && String(source.writerReplicaId) === String(authority)) return { winner: source, policy, reason: "authority-source", resolvedAt };
        if (authority && String(target.writerReplicaId) === String(authority)) return { winner: target, policy, reason: "authority-target", resolvedAt };
        return { winner: lwwWinner(source, target), policy, reason: "authority-absent-fallback-lww", resolvedAt };
      }
      case ConflictPolicy.MERGE: {
        return { winner: mergeRecords(category, source, target), policy, reason: "deterministic-merge", resolvedAt };
      }
      case ConflictPolicy.CUSTOM: {
        const resolver = this.customResolvers[category] ?? this.customResolvers.default;
        if (typeof resolver !== "function") throw new UnresolvedConflictError(`No custom resolver registered for "${category}"`, { reason: ReplicationFailureReason.UNRESOLVED_CONFLICT, details: { category } });
        const winner = resolver(conflict);
        if (!winner || typeof winner !== "object") throw new UnresolvedConflictError("Custom resolver returned no winner", { details: { category } });
        return { winner, policy, reason: "custom-resolver", resolvedAt };
      }
      default:
        throw new ReplicationValidationError(`Unknown conflict policy "${policy}"`, { details: { policy } });
    }
  }

  /** Resolve many conflicts. @returns {object[]} resolutions with audit fields */
  resolveAll(conflicts, options = {}) {
    return conflicts.map((c) => {
      const r = this.resolve(c, options);
      return { category: c.category, entityId: c.entityId, policy: r.policy, reason: r.reason, winner: r.winner, sourceVersion: c.source?.version, targetVersion: c.target?.version, resolvedAt: r.resolvedAt };
    });
  }

  /** Build a conflict-audit record (no content). */
  static auditEntry(conflict, resolution) {
    return {
      category: conflict.category,
      entityId: conflict.entityId,
      policy: resolution.policy,
      reason: resolution.reason,
      sourceVersion: conflict.source?.version,
      targetVersion: conflict.target?.version,
      sourceWriter: conflict.source?.writerReplicaId,
      targetWriter: conflict.target?.writerReplicaId,
      winnerWriter: resolution.winner?.writerReplicaId,
      winnerVersion: resolution.winner?.version,
      at: resolution.resolvedAt,
    };
  }
}

/** Last-write-wins with a deterministic tie-break (higher writerReplicaId). */
function lwwWinner(a, b) {
  const ta = new Date(a.updatedAt ?? 0).getTime();
  const tb = new Date(b.updatedAt ?? 0).getTime();
  if (ta > tb) return a;
  if (tb > ta) return b;
  return String(a.writerReplicaId) >= String(b.writerReplicaId) ? a : b;
}
