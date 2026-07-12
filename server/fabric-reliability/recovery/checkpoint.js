/**
 * @module fabric-reliability/recovery/checkpoint
 *
 * The **operation checkpoint** — a recoverable, control-plane-only snapshot of an in-flight fabric
 * operation: its id, kind, current state, attempt number, and OPAQUE resume `data` (ids + the pipeline
 * stage reached — never content). The recovery engine writes a checkpoint before running an operation and
 * updates it as the operation progresses, so an interrupted operation can be resumed (or gracefully
 * failed) from a consistent point after a crash / restart / timeout.
 *
 * @security The checkpoint `data` bag is scrubbed of content by the validators' no-content scan before any
 * persist — it carries stage markers + ids only.
 */

import { OperationState } from "../types/types.js";

/** Build a fresh checkpoint for an operation. */
export function createCheckpoint({ operationId, kind, data = {}, at }) {
  const now = at ?? new Date().toISOString();
  return {
    operationId,
    kind,
    state: OperationState.RUNNING,
    attempt: 1,
    data: { ...data },
    startedAt: now,
    updatedAt: now,
  };
}

/** Apply a state/attempt/data patch to a checkpoint immutably. */
export function patchCheckpoint(checkpoint, patch, at) {
  return {
    ...checkpoint,
    ...patch,
    data: patch.data ? { ...checkpoint.data, ...patch.data } : checkpoint.data,
    updatedAt: at ?? new Date().toISOString(),
  };
}

/** Is a checkpoint terminal (no further recovery needed)? */
export function isTerminal(checkpoint) {
  return [OperationState.SUCCEEDED, OperationState.RECOVERED, OperationState.GRACEFULLY_FAILED, OperationState.ABORTED].includes(checkpoint?.state);
}
