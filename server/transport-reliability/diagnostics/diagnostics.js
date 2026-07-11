/**
 * @module transport-reliability/diagnostics
 *
 * **Transfer diagnostics.** Assembles a rich, read-only diagnostic view of a transfer's reliability:
 * its current state + health, resume checkpoint, recovery/resume/migration counts, the recovery
 * history, and a resume plan (what would be re-sent if it resumed now). Pure assembly over the records
 * the manager passes in — no I/O.
 *
 * @security Diagnostics carry CONTROL-PLANE metadata + numeric aggregates ONLY.
 */

import { scoreHealth } from "../monitoring/healthMonitor.js";
import { planResume } from "../resume/resumePlanner.js";

/**
 * Build a diagnostics object for a transfer.
 * @param {object} params `{ record, recoveryHistory?, migrationHistory?, now? }`
 * @returns {object}
 */
export function buildDiagnostics({ record, recoveryHistory = [], migrationHistory = [], now = Date.now() } = {}) {
  if (!record) return null;
  const health = scoreHealth(record, { now });
  let resumePlan = null;
  try {
    resumePlan = planResume(record.checkpoint ?? { totalChunks: record.checkpoint?.totalChunks ?? 1 }, { now });
  } catch {
    resumePlan = null;
  }
  return {
    transferId: record.transferId,
    conversationId: record.conversationId,
    state: record.state,
    connectionId: record.connectionId ?? null,
    priority: record.priority,
    health,
    checkpoint: record.checkpoint ?? null,
    resumePlan,
    counters: {
      recoveryCount: record.recoveryCount ?? 0,
      resumeCount: record.resumeCount ?? 0,
      migrationCount: record.migrationCount ?? 0,
    },
    recoveryHistory: recoveryHistory.slice(-20),
    migrationHistory: migrationHistory.slice(-20),
    registeredAt: record.registeredAt,
    lastActivityAt: record.lastActivityAt,
    updatedAt: record.updatedAt,
  };
}
