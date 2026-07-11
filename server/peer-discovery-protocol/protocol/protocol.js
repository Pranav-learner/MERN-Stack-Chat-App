/**
 * @module pdp/protocol
 *
 * The **Peer Discovery Protocol** definition — the small, stable description of the protocol
 * itself: its identifier, version, the ordered workflow, and the failure-handling contract that
 * every stage honours. This is the reference a consumer reads to understand *what PDP does* without
 * reading the orchestration internals.
 *
 * @protocol PDP is a deterministic, forward-only pipeline over the three Sprint 1–3 subsystems:
 *
 * ```
 *  ┌──────────┐   ┌─────────┐   ┌──────────┐   ┌──────────────┐   ┌───────────┐   ┌──────┐
 *  │ identity │ → │ devices │ → │ presence │ → │ capabilities │ → │ selection │ → │ plan │
 *  └──────────┘   └─────────┘   └──────────┘   └──────────────┘   └───────────┘   └──────┘
 *   Discovery      Discovery      Presence       Capabilities        Selectors      Planner
 * ```
 *
 * Every stage either advances the workflow or fails it with a machine-readable
 * {@link module:pdp/types.PdpFailureReason}; a recoverable failure can be retried (RECOVERY). PDP
 * establishes NO connection — its sole output is a validated {@link module:pdp/types.ConnectionPlan}
 * that a FUTURE Layer 7 (NAT Traversal / ICE / WebRTC) consumes.
 */

import {
  PDP_PROTOCOL,
  PDP_PROTOCOL_VERSION,
  WORKFLOW_STAGE_ORDER,
  WorkflowStage,
  PdpFailureReason,
} from "../types/types.js";

/** Whether a failure reason is RECOVERABLE (a retry might succeed) vs terminal-by-nature. */
const RECOVERABLE_REASONS = new Set([
  PdpFailureReason.NO_ACTIVE_DEVICES, // devices may come online → retry can succeed
  PdpFailureReason.PRESENCE_CONFLICT,
  PdpFailureReason.INTERNAL_ERROR,
  PdpFailureReason.EXPIRED_SESSION,
]);

/**
 * Whether a failed workflow can be recovered (retried). Unknown-user / no-discoverable-devices /
 * capability-conflict are treated as NON-recoverable (retrying won't help without a state change
 * elsewhere), while a transient "no active devices" or internal error is recoverable.
 * @param {string} reason one of {@link PdpFailureReason} @returns {boolean}
 */
export function isRecoverableFailure(reason) {
  return RECOVERABLE_REASONS.has(reason);
}

/** A concise, serializable description of the protocol (for a `/protocol` info endpoint / docs). */
export const PROTOCOL_DEFINITION = Object.freeze({
  protocol: PDP_PROTOCOL,
  version: PDP_PROTOCOL_VERSION,
  stages: WORKFLOW_STAGE_ORDER,
  subsystems: Object.freeze({
    [WorkflowStage.IDENTITY]: "discovery",
    [WorkflowStage.DEVICES]: "discovery",
    [WorkflowStage.PRESENCE]: "presence",
    [WorkflowStage.CAPABILITIES]: "capabilities",
    [WorkflowStage.SELECTION]: "pdp/selectors",
    [WorkflowStage.PLAN]: "pdp/planner",
  }),
  output: "connection-plan",
  establishesConnection: false, // Layer 7 does that
});
