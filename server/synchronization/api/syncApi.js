/**
 * @module synchronization/api
 *
 * The stable **synchronization service facade** the HTTP controller delegates to. Wraps the
 * {@link SynchronizationManager} with a flat, owner-scoped surface: register/update/get replica,
 * compute missing state, start/pause/resume/cancel sync, dispense operations, record progress, and read
 * status/progress/plan/diagnostics/health.
 *
 * @security Every mutating op is owner-scoped in the manager; reads return version metadata + counts
 * only.
 */

export function createSyncApi(manager) {
  return {
    // replicas
    registerReplica: (params) => manager.registerReplica(params),
    updateReplica: ({ replicaId, categoryVersions, metadata }) => manager.updateReplica(replicaId, { categoryVersions, metadata }),
    getReplica: ({ replicaId, deviceId }) => manager.getReplica({ replicaId, deviceId }),

    // delta
    computeMissingState: (params) => manager.computeMissingState(params),

    // sessions
    startSync: (params) => manager.startSync(params),
    getNextOperations: ({ sessionId, max, actingDevice }) => manager.getNextOperations({ sessionId, max, actingDevice }),
    recordProgress: (params) => manager.recordProgress(params),
    pauseSync: ({ sessionId, actingDevice }) => manager.pauseSync(sessionId, { actingDevice }),
    resumeSync: ({ sessionId, actingDevice }) => manager.resumeSync(sessionId, { actingDevice }),
    cancelSync: ({ sessionId, actingDevice, reason }) => manager.cancelSync(sessionId, { actingDevice, reason }),

    // reads
    getSession: ({ sessionId, actingDevice }) => manager.getSession(sessionId, { actingDevice }),
    getStatus: ({ sessionId }) => manager.getStatus(sessionId),
    getProgress: ({ sessionId }) => manager.getProgress(sessionId),
    getPlan: ({ sessionId, includeOperations }) => manager.getPlan(sessionId, { includeOperations }),
    getDiagnostics: ({ sessionId, actingDevice }) => manager.getDiagnostics(sessionId, { actingDevice }),
    listSessions: ({ deviceId, userId }) => manager.listSessions({ deviceId, userId }),
    health: () => manager.health(),
  };
}
