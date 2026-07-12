/**
 * @module fabric-reliability/recovery/recoveryStrategies
 *
 * **Per-stage recovery strategies** (STEP 3) — how each kind of interrupted fabric operation is resumed.
 * A strategy decides, given the checkpoint + failure class, whether to RESUME (re-run the operation from
 * its checkpoint), REPLAN (defer / reschedule), or GRACEFULLY FAIL. The default strategy resumes idempotent
 * control-plane operations by re-invoking the executor from the recorded stage; specialized strategies
 * cover the pipeline stages the sprint enumerates (decision / execution / scheduler / policy / route /
 * synchronization / media). Strategies are pluggable — a deployment registers its own per kind.
 *
 * All strategies preserve EXECUTION CONSISTENCY: they only re-run operations that are safe to repeat
 * (control-plane, checkpointed), and they never partially apply — an operation either resumes to success
 * or is recorded as gracefully failed.
 *
 * @security Reasons over checkpoint stage markers + ids only. No content.
 */

import { FabricOperationKind, FailureClass, RecoveryOutcome } from "../types/types.js";

/** The default strategy: resume by re-invoking the executor (safe for idempotent control-plane ops). */
export const defaultRecoveryStrategy = {
  id: "recovery.default",
  describe: "Resume by re-invoking the checkpointed operation.",
  canResume(_checkpoint, failureClass) {
    // caller errors + permanent failures are never resumed
    return ![FailureClass.VALIDATION, FailureClass.AUTHORIZATION, FailureClass.PERMANENT].includes(failureClass);
  },
  async resume(checkpoint, executor) {
    const result = await executor({ attempt: (checkpoint.attempt ?? 1) + 1, checkpoint, recovering: true });
    return { outcome: RecoveryOutcome.RESUMED, result };
  },
};

/** Scheduler/dispatch recovery: a resource-pressure failure REPLANS (defer) rather than hammering. */
export const schedulerRecoveryStrategy = {
  id: "recovery.scheduler",
  describe: "Replan (defer) a scheduling operation that failed under resource pressure.",
  canResume(_checkpoint, failureClass) {
    return failureClass !== FailureClass.PERMANENT && failureClass !== FailureClass.AUTHORIZATION;
  },
  async resume(checkpoint, executor, { failureClass } = {}) {
    if (failureClass === FailureClass.RESOURCE) return { outcome: RecoveryOutcome.REPLANNED, result: { deferred: true, reason: "resource-pressure" } };
    const result = await executor({ attempt: (checkpoint.attempt ?? 1) + 1, checkpoint, recovering: true });
    return { outcome: RecoveryOutcome.RESUMED, result };
  },
};

/** Execution recovery: resume from the checkpointed step stage (the orchestrator is step-idempotent). */
export const executionRecoveryStrategy = {
  id: "recovery.execution",
  describe: "Resume orchestration from the checkpointed step stage.",
  canResume: defaultRecoveryStrategy.canResume,
  resume: defaultRecoveryStrategy.resume,
};

/**
 * Build the default strategy map (kind → strategy). A deployment overrides / extends it. Kinds without an
 * explicit strategy fall back to {@link defaultRecoveryStrategy}.
 */
export function createDefaultRecoveryStrategies() {
  return new Map([
    [FabricOperationKind.SCHEDULE, schedulerRecoveryStrategy],
    [FabricOperationKind.DISPATCH, schedulerRecoveryStrategy],
    [FabricOperationKind.COMMUNICATION_EXECUTE, executionRecoveryStrategy],
    [FabricOperationKind.SUBSYSTEM_CALL, executionRecoveryStrategy],
  ]);
}
