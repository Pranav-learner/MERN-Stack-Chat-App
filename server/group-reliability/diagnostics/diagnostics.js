/**
 * @module group-reliability/diagnostics
 *
 * **Group-operation diagnostics.** Assembles a rich, read-only diagnostic view of a group operation's
 * reliability: its state + health, resume checkpoint, recovery/resume/retry counts, backlog, the
 * recovery history, and a resume plan (what would re-run if it resumed now). Pure assembly over the
 * records the manager passes in — no I/O.
 *
 * @security Diagnostics carry CONTROL-PLANE metadata + numeric aggregates ONLY.
 */

import { scoreHealth } from "../health/healthMonitor.js";
import { planResume } from "../recovery/checkpoint.js";

/** Build a diagnostics object for a group operation. */
export function buildDiagnostics({ record, recoveryHistory = [], now = Date.now() } = {}) {
  if (!record) return null;
  const health = scoreHealth(record, { now });
  let resumePlan = null;
  try {
    resumePlan = planResume(record.checkpoint ?? { totalTargets: 0 }, { now });
  } catch {
    resumePlan = null;
  }
  return {
    operationId: record.operationId,
    groupId: record.groupId,
    operationType: record.operationType,
    state: record.state,
    health,
    checkpoint: record.checkpoint ?? null,
    resumePlan,
    keyVersion: record.keyVersion ?? null,
    counters: {
      recoveryCount: record.recoveryCount ?? 0,
      resumeCount: record.resumeCount ?? 0,
      retryCount: record.retryCount ?? 0,
    },
    backlog: record.checkpoint?.pendingTargets ?? 0,
    recoveryHistory: recoveryHistory.slice(-20),
    registeredAt: record.registeredAt,
    lastActivityAt: record.lastActivityAt,
    updatedAt: record.updatedAt,
  };
}
