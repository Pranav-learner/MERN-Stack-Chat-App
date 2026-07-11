/**
 * @module replication/history
 *
 * **Replication history recorders.** Thin, storage-independent helpers that append audit trails —
 * replica updates, detected conflicts, merges, version history, and delta replications — to whichever
 * repository is injected. The manager records history as it reconciles replicas so a device (or a
 * future Layer 10) can review how a replica evolved and how each conflict was resolved.
 *
 * @security History entries carry ids + versions + policies + counts ONLY — never content.
 */

/** Build a history facade over a repository bundle. */
export function createHistory(repo) {
  const stores = repo ?? {};
  return {
    /** Record a replica-lifecycle entry. */
    async recordReplica(entry) {
      return stores.replicaHistory?.record?.({ kind: "replica", ...entry, at: entry.at ?? new Date().toISOString() });
    },
    /** Record a detected/resolved conflict. */
    async recordConflict(entry) {
      return stores.conflictHistory?.record?.({ kind: "conflict", ...entry, at: entry.at ?? new Date().toISOString() });
    },
    /** Record a merge. */
    async recordMerge(entry) {
      return stores.mergeHistory?.record?.({ kind: "merge", ...entry, at: entry.at ?? new Date().toISOString() });
    },
    /** Record a version-history entry for an entity. */
    async recordVersion(entry) {
      return stores.versionHistory?.record?.({ kind: "version", ...entry, at: entry.at ?? new Date().toISOString() });
    },
    /** Record a delta replication. */
    async recordDelta(entry) {
      return stores.deltaHistory?.record?.({ kind: "delta", ...entry, at: entry.at ?? new Date().toISOString() });
    },

    async listConflicts(replicaId, options = {}) {
      return (await stores.conflictHistory?.listByReplica?.(replicaId, options)) ?? [];
    },
    async listMerges(replicaId, options = {}) {
      return (await stores.mergeHistory?.listByReplica?.(replicaId, options)) ?? [];
    },
    async listVersions(replicaId, options = {}) {
      return (await stores.versionHistory?.listByReplica?.(replicaId, options)) ?? [];
    },
  };
}
