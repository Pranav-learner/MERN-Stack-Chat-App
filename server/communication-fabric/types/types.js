/**
 * @module communication-fabric/types
 *
 * Enums + constants for the **Distributed Communication Fabric** — Layer 12, Sprint 1. The Fabric is the
 * ORCHESTRATION layer of the whole platform: it is the single entry point for every communication
 * request, and it coordinates the frozen lower layers (security, connectivity, messaging, media,
 * synchronization, groups, delivery) WITHOUT reimplementing any of them.
 *
 * A request flows: **Application → Fabric Manager → Context → Decision Engine → Strategy → Route/Plan →
 * Orchestration → Subsystem delegation → Execution**. Every stage in that pipeline is modelled here as a
 * small, frozen vocabulary so the pipeline stays declarative and every decision is inspectable.
 *
 * @security The Fabric reasons over communication CONTROL-PLANE metadata ONLY — request kind, recipients,
 * conversation/media/priority descriptors, availability, policy + strategy identifiers, and execution
 * bookkeeping. It NEVER handles message plaintext, ciphertext, or key material; the actual bytes always
 * move through the frozen lower layers (Layer 8 transport, Layer 11 media), and the Fabric only decides
 * WHICH of those subsystems runs and in WHAT order.
 *
 * @performance Every vocabulary here is a frozen object of string constants + rank maps, so decision +
 * routing + policy evaluation are constant-time table lookups rather than branching cascades. This is the
 * seam Sprint 2 (intelligent / adaptive routing) extends WITHOUT redesigning the pipeline.
 *
 * @evolution Strategy selection, routing, and policy are all pluggable through interfaces (never
 * `switch`/`if` cascades) so future communication systems — Voice, Video, screen-share — register into
 * the same pipeline without touching this file or the manager.
 */

// === communication classification ==========================================

/**
 * WHAT kind of communication is being requested. This is the primary discriminator the Decision Engine
 * keys off of. Voice/Video are declared but INERT placeholders — Sprint 1 never routes them (Layer 12+).
 * @readonly @enum {string}
 */
export const CommunicationType = Object.freeze({
  DIRECT_MESSAGE: "direct-message", // 1:1 text/opaque message (Layer 8 data plane)
  GROUP_MESSAGE: "group-message", // group fan-out (Layer 10 group communication)
  MEDIA_TRANSFER: "media-transfer", // file/image/video/audio blob (Layer 11 media platform)
  SYNCHRONIZATION: "synchronization", // multi-device state sync (Layer 9)
  PRESENCE: "presence", // presence / availability advertisement (Layer 6)
  RECEIPT: "receipt", // delivery / read receipt propagation (Layer 10 receipts)
  CONTROL: "control", // control-plane signalling (typing, rekey hints, etc.)
  VOICE: "voice", // PLACEHOLDER — inert in Sprint 1 (future real-time)
  VIDEO: "video", // PLACEHOLDER — inert in Sprint 1 (future real-time)
});

export const ALL_COMMUNICATION_TYPES = Object.freeze(Object.values(CommunicationType));

/** Communication types that are declared but NOT executed in this sprint (guarded by validators). */
export const DEFERRED_COMMUNICATION_TYPES = Object.freeze([CommunicationType.VOICE, CommunicationType.VIDEO]);

/**
 * The shape of the conversation the request belongs to. Distinct from {@link CommunicationType}: a MEDIA
 * transfer can occur in a DIRECT or a GROUP conversation.
 * @readonly @enum {string}
 */
export const ConversationType = Object.freeze({
  DIRECT: "direct", // 1:1 between two identities
  GROUP: "group", // a Layer 10 group
  BROADCAST: "broadcast", // one-to-many, no reply channel
  SELF: "self", // multi-device sync to the sender's own devices
});

export const ALL_CONVERSATION_TYPES = Object.freeze(Object.values(ConversationType));

/**
 * The class of media a request carries (NONE for pure control/text). Drives the Media Strategy + media
 * policy. Descriptive only — the Fabric never inspects media bytes.
 * @readonly @enum {string}
 */
export const MediaType = Object.freeze({
  NONE: "none",
  IMAGE: "image",
  VIDEO: "video",
  AUDIO: "audio",
  VOICE_NOTE: "voice-note",
  DOCUMENT: "document",
  BINARY: "binary",
});

export const ALL_MEDIA_TYPES = Object.freeze(Object.values(MediaType));

// === priority ==============================================================

/** Request priority. Higher {@link PRIORITY_RANK} = more urgent → influences routing + scheduling seams. @readonly @enum {string} */
export const Priority = Object.freeze({
  LOW: "low", // background sync, analytics
  NORMAL: "normal", // ordinary messages (default)
  HIGH: "high", // user-visible, latency-sensitive
  URGENT: "urgent", // control/security signalling, must not queue behind bulk
});

export const ALL_PRIORITIES = Object.freeze(Object.values(Priority));

/** Priority rank (higher = more urgent). Constant-time comparison for policy + routing. */
export const PRIORITY_RANK = Object.freeze({ low: 0, normal: 1, high: 2, urgent: 3 });

// === recipient availability ================================================

/**
 * The Fabric's view of whether the recipient set is reachable. Fed by Layer 6 presence at wiring time;
 * defaults to UNKNOWN when presence is not supplied (Fabric stays functional without it).
 * @readonly @enum {string}
 */
export const RecipientAvailability = Object.freeze({
  ONLINE: "online", // at least one recipient device is reachable now
  PARTIAL: "partial", // some recipients/devices reachable, some not (groups)
  OFFLINE: "offline", // no recipient device reachable → offline/store-and-forward path
  UNKNOWN: "unknown", // presence not resolved (default; treated conservatively)
});

export const ALL_AVAILABILITIES = Object.freeze(Object.values(RecipientAvailability));

// === synchronization posture ===============================================

/** The synchronization state of the conversation/replica relevant to a request. @readonly @enum {string} */
export const SyncState = Object.freeze({
  CONVERGED: "converged", // replicas in sync; no catch-up needed
  DIVERGED: "diverged", // a delta exists; sync should accompany/precede delivery
  UNKNOWN: "unknown", // sync layer not consulted (default)
});

export const ALL_SYNC_STATES = Object.freeze(Object.values(SyncState));

// === strategies ============================================================

/**
 * The strategy families the Decision Engine can select. Selection happens through the strategy INTERFACE
 * (see `strategies/strategy.js`), never a conditional cascade. RELAY + HYBRID are declared placeholders
 * whose planning is intentionally minimal in Sprint 1 (Sprint 2 fills them in).
 * @readonly @enum {string}
 */
export const StrategyType = Object.freeze({
  DIRECT: "direct", // peer-to-peer / direct data-plane delivery (Layer 8)
  RELAY: "relay", // PLACEHOLDER — server-relayed path (Sprint 2 adaptive)
  OFFLINE: "offline", // store-and-forward for offline recipients (Layer 8 + Layer 9)
  MEDIA: "media", // media pipeline delivery (Layer 11)
  GROUP: "group", // group fan-out (Layer 10)
  SYNCHRONIZATION: "synchronization", // multi-device state sync (Layer 9)
  HYBRID: "hybrid", // PLACEHOLDER — composes multiple strategies (Sprint 2)
});

export const ALL_STRATEGY_TYPES = Object.freeze(Object.values(StrategyType));

/** Strategies that are declared as extension seams but do only minimal planning in Sprint 1. */
export const PLACEHOLDER_STRATEGIES = Object.freeze([StrategyType.RELAY, StrategyType.HYBRID]);

// === subsystems ============================================================

/**
 * The lower-layer subsystems the Fabric can DISCOVER + delegate to via the registry — never a hard
 * import. VOICE/VIDEO are future kinds that plug in without touching the Fabric. Each registered adapter
 * declares its `kind` from this set.
 * @readonly @enum {string}
 */
export const SubsystemKind = Object.freeze({
  MESSAGING: "messaging", // Layer 8 reliable P2P messaging
  TRANSPORT: "transport", // Layer 8 large-payload transport engine
  MEDIA: "media", // Layer 11 secure media platform
  SYNCHRONIZATION: "synchronization", // Layer 9 offline sync + replication
  GROUP: "group", // Layer 10 group communication
  CONNECTIVITY: "connectivity", // Layer 6/7 discovery + connectivity
  PRESENCE: "presence", // Layer 6 presence
  DELIVERY: "delivery", // Layer 10 delivery/read receipts
  SECURITY: "security", // Layer 3/4/5 secure session context (advisory)
  VOICE: "voice", // FUTURE — inert placeholder
  VIDEO: "video", // FUTURE — inert placeholder
});

export const ALL_SUBSYSTEM_KINDS = Object.freeze(Object.values(SubsystemKind));

// === routing ===============================================================

/**
 * The route family a plan step travels over. Sprint 1 defines the routing VOCABULARY + framework only —
 * NO adaptive selection / scoring (Sprint 2). The planner picks deterministically from the strategy.
 * @readonly @enum {string}
 */
export const RouteKind = Object.freeze({
  DIRECT_TRANSPORT: "direct-transport", // straight to the data plane
  RELAYED_TRANSPORT: "relayed-transport", // via a relay (placeholder)
  STORE_AND_FORWARD: "store-and-forward", // queued for an offline recipient
  MEDIA_PIPELINE: "media-pipeline", // through the media platform
  GROUP_FANOUT: "group-fanout", // through group fan-out
  SYNC_CHANNEL: "sync-channel", // through the sync engine
  LOCAL: "local", // no network hop (e.g. self bookkeeping)
});

export const ALL_ROUTE_KINDS = Object.freeze(Object.values(RouteKind));

// === execution =============================================================

/** The lifecycle status of a fabric execution. @readonly @enum {string} */
export const ExecutionStatus = Object.freeze({
  PENDING: "pending", // request accepted, not yet planned
  PLANNED: "planned", // execution plan built, not started
  EXECUTING: "executing", // orchestration in progress
  COMPLETED: "completed", // all required steps succeeded
  PARTIAL: "partial", // some steps succeeded, some failed (best-effort)
  FAILED: "failed", // a required step failed and no fallback recovered it
  ABORTED: "aborted", // aborted before/while planning (validation/policy)
});

export const ALL_EXECUTION_STATUSES = Object.freeze(Object.values(ExecutionStatus));

/** Terminal execution states (no further transitions). */
export const TERMINAL_EXECUTION_STATUSES = Object.freeze([
  ExecutionStatus.COMPLETED,
  ExecutionStatus.PARTIAL,
  ExecutionStatus.FAILED,
  ExecutionStatus.ABORTED,
]);

/** The status of a single orchestration step. @readonly @enum {string} */
export const StepStatus = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  SKIPPED: "skipped", // conditionally skipped (e.g. optional step, unmet precondition)
  FELL_BACK: "fell-back", // failed but a fallback step recovered it
});

export const ALL_STEP_STATUSES = Object.freeze(Object.values(StepStatus));

// === decision confidence ===================================================

/**
 * How confident the Decision Engine is in a decision — advisory metadata Sprint 2 uses to decide whether
 * to re-evaluate adaptively. @readonly @enum {string}
 */
export const DecisionConfidence = Object.freeze({
  DEFINITIVE: "definitive", // unambiguous (exactly one strategy matched with full context)
  LIKELY: "likely", // best match with complete-enough context
  TENTATIVE: "tentative", // matched on defaults / missing context (UNKNOWN availability, etc.)
});

export const ALL_DECISION_CONFIDENCES = Object.freeze(Object.values(DecisionConfidence));

// === events ================================================================

/**
 * Internal Fabric event types. Sprint 2 (intelligent routing) CONSUMES these to observe + adapt without
 * modifying the pipeline. Events carry ids + classifications + bookkeeping only — never content/keys.
 * @readonly @enum {string}
 */
export const FabricEventType = Object.freeze({
  COMMUNICATION_REQUESTED: "fabric.communication_requested",
  CONTEXT_BUILT: "fabric.context_built",
  POLICIES_EVALUATED: "fabric.policies_evaluated",
  DECISION_CREATED: "fabric.decision_created",
  STRATEGY_SELECTED: "fabric.strategy_selected",
  ROUTE_PLANNED: "fabric.route_planned",
  EXECUTION_PLANNED: "fabric.execution_planned",
  EXECUTION_STARTED: "fabric.execution_started",
  STEP_STARTED: "fabric.step_started",
  STEP_COMPLETED: "fabric.step_completed",
  STEP_FAILED: "fabric.step_failed",
  EXECUTION_COMPLETED: "fabric.execution_completed",
  EXECUTION_FAILED: "fabric.execution_failed",
});

export const ALL_FABRIC_EVENT_TYPES = Object.freeze(Object.values(FabricEventType));

// === failure reasons =======================================================

/** Machine-readable failure/validation reasons carried on errors + failed executions. */
export const FabricFailureReason = Object.freeze({
  INVALID_REQUEST: "invalid-request",
  INVALID_CONTEXT: "invalid-context",
  UNKNOWN_STRATEGY: "unknown-strategy",
  NO_STRATEGY_MATCHED: "no-strategy-matched",
  MISSING_POLICY: "missing-policy",
  POLICY_DENIED: "policy-denied",
  INVALID_DECISION: "invalid-decision",
  INVALID_PLAN: "invalid-plan",
  SUBSYSTEM_UNAVAILABLE: "subsystem-unavailable",
  SUBSYSTEM_FAILED: "subsystem-failed",
  UNAUTHORIZED: "unauthorized",
  UNSUPPORTED_TYPE: "unsupported-type",
  CONFIGURATION_ERROR: "configuration-error",
  REPOSITORY_INCONSISTENT: "repository-inconsistent",
  CONTENT_LEAK: "content-leak",
  INTERNAL_ERROR: "internal-error",
});

// === constants =============================================================

export const FABRIC_FRAMEWORK = "communication-fabric";
export const FABRIC_SCHEMA_VERSION = 1;
export const FABRIC_LAYER = 12;
export const FABRIC_SPRINT = 1;

/** Decision cache TTL (ms) + max entries — identical (type, conversation, media, priority, availability) contexts reuse a decision. */
export const DEFAULT_DECISION_CACHE_TTL_MS = 15_000;
export const DEFAULT_DECISION_CACHE_MAX = 5_000;

/** Bounded audit-trail retention per execution. */
export const MAX_AUDIT_ENTRIES = 100;

/** Pagination bounds (API hardening). */
export const MAX_PAGE_SIZE = 1000;
export const DEFAULT_PAGE_SIZE = 100;

/**
 * @typedef {object} CommunicationRequest The raw application input to the Fabric (before normalization).
 * @property {string} [requestId] caller-supplied idempotency id (else generated)
 * @property {string} type one of {@link CommunicationType}
 * @property {string} senderId the initiating identity
 * @property {string[]} [recipients] recipient identity ids (direct/broadcast)
 * @property {string} [conversationId] direct conversation id
 * @property {string} [groupId] group id (group conversations)
 * @property {string} [conversationType] one of {@link ConversationType} (inferred if absent)
 * @property {string} [mediaType] one of {@link MediaType} (default NONE)
 * @property {string} [priority] one of {@link Priority} (default NORMAL)
 * @property {object} [payloadRef] OPAQUE reference to the already-encrypted payload (id/size/hash) — never bytes
 * @property {object} [availability] recipient availability hint (from presence)
 * @property {object} [sync] synchronization posture hint
 * @property {object} [security] security-context hint (session ready, etc.)
 * @property {object} [metadata] free-form non-secret metadata
 * @property {object} [policyOverrides] per-request policy overrides
 */

/**
 * @typedef {object} CommunicationDecision The Decision Engine output — HOW communication should occur.
 * @property {string} decisionId @property {string} requestId
 * @property {string} strategyType one of {@link StrategyType}
 * @property {string} primaryRoute one of {@link RouteKind}
 * @property {string[]} subsystems ordered {@link SubsystemKind} the strategy will delegate to
 * @property {string} confidence one of {@link DecisionConfidence}
 * @property {object[]} reasons ordered rule contributions ({ rule, effect, note })
 * @property {string[]} policyRefs applied policy ids @property {object} constraints policy-derived constraints
 * @property {string} createdAt @property {number} version
 */

/**
 * @typedef {object} ExecutionPlan The ordered, delegatable plan built from a decision + strategy + route.
 * @property {string} planId @property {string} requestId @property {string} decisionId
 * @property {string} strategyType @property {object[]} steps ordered {@link PlanStep}
 * @property {object[]} fallbacks alternative steps keyed by the step they recover
 * @property {object} routing route metadata (primary + candidates + diagnostics)
 * @property {string} createdAt @property {number} version
 */

/**
 * @typedef {object} PlanStep One delegatable unit of work in an execution plan.
 * @property {string} stepId @property {string} subsystem one of {@link SubsystemKind}
 * @property {string} action subsystem-agnostic verb (e.g. "deliver", "fanout", "sync", "store")
 * @property {string} route one of {@link RouteKind} @property {boolean} required
 * @property {string[]} [dependsOn] step ids that must succeed first @property {object} params opaque step params
 */
