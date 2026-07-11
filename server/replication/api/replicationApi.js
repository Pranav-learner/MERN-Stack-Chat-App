/**
 * @module replication/api
 *
 * The stable **replication service facade** the HTTP controller delegates to. Wraps the
 * {@link ReplicaManager} with a flat, owner-scoped surface: register/update/status/list replica,
 * compare replicas, synchronize / merge, resolve a conflict, replicate a delta, resume synchronization,
 * and read version/conflict history + diagnostics.
 *
 * @security Every mutating op is owner-scoped in the manager; reads return version metadata + counts
 * only.
 */

export function createReplicationApi(manager) {
  return {
    // replicas
    registerReplica: (params) => manager.registerReplica(params),
    updateReplica: ({ replicaId, categories, metadata, actingDevice }) => manager.updateReplica(replicaId, { categories, metadata }, { actingDevice }),
    getReplicaStatus: ({ replicaId, deviceId, actingDevice }) => manager.getReplicaStatus({ replicaId, deviceId, actingDevice }),
    listReplicas: ({ userId }) => manager.listReplicas({ userId }),

    // comparison + synchronization
    compareReplicas: (params, ctx) => manager.compareReplicas(params, ctx),
    synchronizeReplicas: (params, ctx) => manager.synchronizeReplicas(params, ctx),
    mergeReplica: (params, ctx) => manager.mergeReplica(params, ctx),
    resolveConflict: (params, ctx) => manager.resolveConflict(params, ctx),

    // delta + resume
    replicateDelta: (params, ctx) => manager.replicateDelta(params, ctx),
    resumeSynchronization: (params, ctx) => manager.resumeSynchronization(params, ctx),

    // history + diagnostics
    getVersionHistory: (params) => manager.getVersionHistory(params),
    getConflictHistory: (params) => manager.getConflictHistory(params),
    getDiagnostics: (params) => manager.getDiagnostics(params),
    health: () => manager.health(),
  };
}
