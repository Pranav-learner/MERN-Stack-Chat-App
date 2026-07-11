/**
 * @module pdp/types
 *
 * Enums and type declarations for the **Peer Discovery Protocol (PDP)** — Layer 6, Sprint 4. PDP is
 * the ORCHESTRATION layer: it unifies the three Sprint 1–3 subsystems into one deterministic
 * workflow that answers the whole question at once —
 *
 * > *"Given a target user, which of their devices should I connect to, and how?"*
 *
 * ```
 * Discovery (who + which devices) → Presence (which are reachable) → Capabilities (how they talk)
 *                                        ↓
 *                             Device Selection → Connection Plan
 * ```
 *
 * The primary output is a {@link ConnectionPlan} — a transport-independent, validated plan that a
 * FUTURE Layer 7 (NAT Traversal / ICE / WebRTC) consumes to actually establish a connection.
 *
 * @security PDP composes PUBLIC control-plane data from the three subsystems — identity/device ids,
 * public keys + fingerprints, presence status, negotiated versions/transports/flags. It NEVER
 * exposes private keys, session keys, message keys, chain keys, or shared secrets. See
 * {@link module:pdp/validators} for the enforced no-secret invariant.
 *
 * @evolution PDP is transport-INDEPENDENT and **establishes no connection**. It produces a plan
 * only. The plan's `connection` + `nat` blocks are inert placeholders Layer 7 fills with ICE
 * candidates, relays, and reachability once it implements NAT traversal.
 */

/**
 * Peer-Discovery-Protocol session lifecycle states. A PDP session is a deterministic finite state
 * machine over these (see {@link module:pdp/workflow/lifecycle}).
 *
 * - `CREATED`     — request accepted; workflow not yet started.
 * - `RESOLVING`   — resolving identity → devices → presence (who + which are reachable).
 * - `NEGOTIATING` — negotiating capabilities against the reachable candidate devices.
 * - `PLANNING`    — selecting device(s) + assembling the connection plan.
 * - `COMPLETED`   — a connection plan was produced (terminal, success).
 * - `FAILED`      — a stage failed (terminal unless recovered).
 * - `CANCELLED`   — the requester cancelled (terminal).
 * - `EXPIRED`     — the session outlived its TTL (terminal).
 * - `RECOVERY`    — a recoverable failure is being retried (→ back to RESOLVING).
 * @readonly @enum {string}
 */
export const PdpState = Object.freeze({
  CREATED: "created",
  RESOLVING: "resolving",
  NEGOTIATING: "negotiating",
  PLANNING: "planning",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  RECOVERY: "recovery",
});

/** All PDP states, canonical order. */
export const ALL_PDP_STATES = Object.freeze(Object.values(PdpState));

/** States in which a PDP session is still live / can still progress. */
export const ACTIVE_PDP_STATES = Object.freeze([
  PdpState.CREATED,
  PdpState.RESOLVING,
  PdpState.NEGOTIATING,
  PdpState.PLANNING,
  PdpState.RECOVERY,
]);

/** States from which a PDP session cannot progress further. */
export const TERMINAL_PDP_STATES = Object.freeze([
  PdpState.COMPLETED,
  PdpState.FAILED,
  PdpState.CANCELLED,
  PdpState.EXPIRED,
]);

/** Whether a state is terminal. @param {string} state @returns {boolean} */
export function isTerminalPdpState(state) {
  return TERMINAL_PDP_STATES.includes(state);
}

/** Whether a state is live / still trackable. @param {string} state @returns {boolean} */
export function isActivePdpState(state) {
  return ACTIVE_PDP_STATES.includes(state);
}

/**
 * The ordered workflow stages. Each stage maps to a section of the deterministic pipeline (see
 * {@link module:pdp/workflow}); the manager records which stage a session reached / failed at.
 * @readonly @enum {string}
 */
export const WorkflowStage = Object.freeze({
  IDENTITY: "identity", // validate the target user + resolve their public identity
  DEVICES: "devices", // resolve the target user's discoverable devices (Discovery)
  PRESENCE: "presence", // resolve which of those devices are reachable (Presence)
  CAPABILITIES: "capabilities", // negotiate capabilities against the reachable devices
  SELECTION: "selection", // rank + select device(s) per policy
  PLAN: "plan", // assemble the connection plan
});

/** The workflow stages in execution order. */
export const WORKFLOW_STAGE_ORDER = Object.freeze([
  WorkflowStage.IDENTITY,
  WorkflowStage.DEVICES,
  WorkflowStage.PRESENCE,
  WorkflowStage.CAPABILITIES,
  WorkflowStage.SELECTION,
  WorkflowStage.PLAN,
]);

/**
 * Deterministic device-selection policies. Configurable per discovery request. All are stable:
 * ties break by `deviceId` ascending so selection is reproducible.
 * @readonly @enum {string}
 */
export const SelectionPolicy = Object.freeze({
  CAPABILITY_SCORE: "capability-score", // rank by a score over negotiated capabilities (default)
  NEWEST_ACTIVE: "newest-active", // most-recently-seen reachable device
  HIGHEST_PRIORITY: "highest-priority", // highest declared device priority
  PLATFORM_PREFERENCE: "platform-preference", // prefer a requested platform
  USER_PREFERENCE: "user-preference", // prefer a specific requested deviceId
  LOWEST_LATENCY: "lowest-latency", // FUTURE — latency is a placeholder (all 0); deterministic tie-break
});

/** All selection policies. */
export const ALL_SELECTION_POLICIES = Object.freeze(Object.values(SelectionPolicy));

/**
 * PDP event types. Future Layer 7 (NAT Traversal) subscribes to these.
 * @readonly @enum {string}
 */
export const PdpEventType = Object.freeze({
  DISCOVERY_REQUESTED: "pdp.discovery_requested",
  DISCOVERY_RESOLVED: "pdp.discovery_resolved",
  PRESENCE_RESOLVED: "pdp.presence_resolved",
  CAPABILITIES_NEGOTIATED: "pdp.capabilities_negotiated",
  DEVICE_SELECTED: "pdp.device_selected",
  CONNECTION_PLAN_CREATED: "pdp.connection_plan_created",
  WORKFLOW_COMPLETED: "pdp.workflow_completed",
  WORKFLOW_FAILED: "pdp.workflow_failed",
  WORKFLOW_CANCELLED: "pdp.workflow_cancelled",
  WORKFLOW_EXPIRED: "pdp.workflow_expired",
  WORKFLOW_RECOVERED: "pdp.workflow_recovered",
  STAGE_STARTED: "pdp.stage_started",
  STAGE_COMPLETED: "pdp.stage_completed",
  CACHE_INVALIDATED: "pdp.cache_invalidated",
});

/**
 * Machine-readable reasons attached to workflow failures + validation results.
 * @readonly @enum {string}
 */
export const PdpFailureReason = Object.freeze({
  UNKNOWN_USER: "unknown-user",
  NO_DISCOVERABLE_DEVICES: "no-discoverable-devices",
  NO_ACTIVE_DEVICES: "no-active-devices",
  PRESENCE_CONFLICT: "presence-conflict",
  CAPABILITY_CONFLICT: "capability-conflict",
  NO_COMPATIBLE_DEVICE: "no-compatible-device",
  INVALID_SELECTION: "invalid-selection",
  EXPIRED_PLAN: "expired-plan",
  EXPIRED_SESSION: "expired-session",
  MALFORMED_METADATA: "malformed-metadata",
  UNAUTHORIZED: "unauthorized",
  CANCELLED: "cancelled",
  INTERNAL_ERROR: "internal-error",
});

/** How a connection plan was sourced (observability). */
export const PdpSource = Object.freeze({
  CACHE: "cache",
  COMPUTED: "computed",
});

/** Current PDP record storage schema version. */
export const PDP_SCHEMA_VERSION = 1;

/** The protocol identifier + version stamped onto sessions + plans. */
export const PDP_PROTOCOL = "peer-discovery-protocol";
export const PDP_PROTOCOL_VERSION = "1.0";

/** Default PDP session TTL (ms) — the workflow should complete well within this. */
export const DEFAULT_PDP_SESSION_TTL_MS = 30_000;

/** Default connection-plan TTL (ms) — a plan is a short-lived snapshot; Layer 7 must act on it soon. */
export const DEFAULT_PLAN_TTL_MS = 60_000;

/** Default connection-plan cache TTL (ms). Bounded by the plan TTL. */
export const DEFAULT_PLAN_CACHE_TTL_MS = 15_000;

/** Default connection-plan cache capacity before LRU eviction. */
export const DEFAULT_PLAN_CACHE_LIMIT = 5_000;

/** Default number of devices a plan selects (primary + backups). */
export const DEFAULT_MAX_SELECTED_DEVICES = 3;

/**
 * @typedef {object} SelectedDevice A device chosen for the connection plan, with the evidence that
 *   chose it. PUBLIC only.
 * @property {string} deviceId @property {string|null} identityId
 * @property {object|null} publicIdentity the device's PUBLIC identity descriptor
 * @property {string} presenceStatus one of the presence statuses
 * @property {string|null} lastSeen ISO timestamp
 * @property {string} [platform] @property {string} [softwareVersion]
 * @property {object} capabilities the negotiation RESULT for (requesterDevice ↔ this device)
 * @property {number} score the selection score (policy-dependent)
 * @property {number} rank 0-based selection rank (0 = primary)
 * @property {number} priority derived connection priority
 */

/**
 * @typedef {object} ConnectionPlan The PRIMARY OUTPUT of PDP — a transport-independent, validated
 *   plan describing which device(s) to connect to + how. Consumed by a FUTURE Layer 7. It contains
 *   NO way to actually reach a peer (that is Layer 7); `connection` + `nat` are inert placeholders.
 * @property {string} planId @property {string} discoveryId the producing PDP session id
 * @property {string} requester @property {string} requesterDevice
 * @property {string} targetUser
 * @property {SelectedDevice[]} selectedDevices ranked; index 0 is the primary
 * @property {string} primaryDeviceId
 * @property {Array<{deviceId:string,status:string,lastSeen:string|null}>} presenceSnapshot
 * @property {object} negotiatedCapabilities the negotiation result for the primary device
 * @property {string|null} preferredTransport @property {string[]} fallbackTransports
 * @property {string|null} protocolVersion @property {string|null} cryptoVersion
 * @property {boolean} cryptoCompatible
 * @property {number} priority @property {string} selectionPolicy
 * @property {object} connection FUTURE placeholder — inert connection-metadata block
 * @property {object} nat FUTURE placeholder — inert NAT-traversal metadata block
 * @property {string} createdAt @property {string} expiresAt
 * @property {number} schemaVersion @property {object} metadata
 */

/**
 * @typedef {object} PdpSession A single discovery-protocol run's record. Tracks the workflow state,
 *   the stage reached, the produced plan id, audit + stage history.
 * @property {string} discoveryId @property {string} requester @property {string} requesterDevice
 * @property {string} targetUser @property {string[]} targetDevices requested subset (empty = all)
 * @property {string} state one of {@link PdpState} @property {string} stage last {@link WorkflowStage}
 * @property {string} selectionPolicy @property {string|null} planId
 * @property {string|null} failureReason @property {number} attempts recovery attempt counter
 * @property {string} requestTime @property {string} createdAt @property {string} updatedAt
 * @property {string} expiresAt @property {string|null} completedAt
 * @property {object[]} stageHistory @property {object[]} audit
 * @property {Array<{from:string|null,to:string,at:string,reason?:string}>} history
 * @property {object} metadata @property {number} schemaVersion
 */
