/**
 * @module shs/hardening/protocol/freeze
 *
 * **Protocol freeze** for Layer 4. This module declares the FROZEN public protocol
 * surface — the contract Layer 5 builds on and MUST NOT break: protocol name +
 * versions, message types, handshake + session states, key-agreement algorithms,
 * event names, and the session model shape. It also documents the **extension
 * points** Layer 5 uses to add functionality additively.
 *
 * `PROTOCOL_MANIFEST` is a pure literal; {@link manifestHash} fingerprints it so CI /
 * {@link assertFrozen} can detect an accidental breaking change to the public surface.
 *
 * @security The manifest lists PUBLIC protocol identifiers only. Freezing the surface
 * prevents silent downgrades of the contract and gives Layer 5 a stable target.
 */

import crypto from "node:crypto";
import { ALL_MESSAGE_TYPES } from "../../types.js";
import { ALL_HANDSHAKE_STATES } from "../../types.js";
import { SUPPORTED_VERSIONS, CURRENT_VERSION, MINIMUM_VERSION } from "../../protocol/version.js";
import { SUPPORTED_ALGORITHMS, SUPPORTED_CRYPTO_VERSIONS } from "../../key-agreement/types.js";
import { ALL_SESSION_STATES } from "../../session/types.js";

/** The frozen Layer 4 protocol manifest (v1). */
export const PROTOCOL_MANIFEST = Object.freeze({
  protocol: "SHS",
  layer: 4,
  frozenAt: "layer-4-sprint-4",
  version: {
    current: CURRENT_VERSION,
    minimum: MINIMUM_VERSION,
    supported: [...SUPPORTED_VERSIONS],
  },
  cryptoVersion: {
    supported: [...SUPPORTED_CRYPTO_VERSIONS],
  },
  messageTypes: [...ALL_MESSAGE_TYPES],
  handshakeStates: [...ALL_HANDSHAKE_STATES],
  sessionStates: [...ALL_SESSION_STATES],
  keyAgreementAlgorithms: [...SUPPORTED_ALGORITHMS],
  events: {
    handshake: ["started", "negotiating", "accepted", "rejected", "cancelled", "expired", "resumed", "completed", "failed", "timeout", "restarted", "aborted", "state_changed"],
    keyAgreement: ["negotiation_succeeded", "negotiation_failed", "ephemeral_key_generated", "peer_key_received", "shared_secret_derived", "session_material_created", "completed", "failed", "ephemeral_keys_destroyed"],
    session: ["created", "activated", "idle", "paused", "resumed", "expired", "closed", "destroyed", "validated", "failed", "rekey_requested", "rekeyed"],
    hardening: ["replay_detected", "downgrade_blocked", "integrity_violation", "recovery_attempted", "recovery_succeeded", "recovery_aborted", "session_guard_failed"],
  },
  sessionModel: {
    publicFields: ["sessionId", "handshakeId", "participants", "deviceIds", "protocolVersion", "encryptionKey", "authenticationKey", "status", "generation", "rekeyHistory", "createdAt", "lastActivityAt", "expiresAt", "maxLifetimeMs", "idleTimeoutMs", "security", "metadata", "extensions"],
    keyMetadataFields: ["algorithm", "length", "keyId", "fingerprint"],
    secretFields: "NONE — raw keys/secrets are never in the model (device-local only)",
  },
});

/**
 * The extension points Layer 5 (and beyond) use to extend the protocol WITHOUT
 * redesigning Layer 4.
 * @type {ReadonlyArray<{ point: string, how: string }>}
 */
export const EXTENSION_POINTS = Object.freeze([
  { point: "New protocol version", how: "Add to SUPPORTED_VERSIONS + VERSION_FEATURES under a new minor; negotiation/downgrade guards absorb it." },
  { point: "New key-agreement algorithm", how: "Add to key-agreement SUPPORTED_ALGORITHMS; cryptoNegotiation + downgrade guard pick it up." },
  { point: "Message confidentiality", how: "Flip the reserved ENCRYPTED frame flag in the serializer and wrap the body; the envelope is unchanged." },
  { point: "Forward secrecy / ratchet", how: "Register a rekey strategy in session/rekey REKEY_STRATEGIES using the reserved ratchetMaterial as the root; generation counter + rekey events already exist." },
  { point: "Session keys for messaging", how: "Read device-local session keys via SecureSessionManager.loadSessionKeys(sessionId); encryptionKey (aes-256-gcm) + macKey are ready." },
  { point: "Event consumption", how: "Subscribe to the handshake/key-agreement/session/hardening event buses; all are typed and stable (see manifest.events)." },
  { point: "Distributed replay cache", how: "Provide a cache with has/add/prune to ReplayProtector for multi-node deployments." },
  { point: "Observability export", how: "Poll MetricsCollector.snapshot() / HealthMonitor.health() / Tracer.spans; adapt to Prometheus/OTel." },
]);

/** A stable fingerprint of the frozen manifest (SHA-256 of its canonical JSON). */
export function manifestHash() {
  return crypto.createHash("sha256").update(canonical(PROTOCOL_MANIFEST)).digest("hex");
}

/**
 * Assert a manifest matches the frozen one (detects accidental breaking changes).
 * @param {object} candidate @throws {Error}
 */
export function assertFrozen(candidate) {
  const a = canonical(PROTOCOL_MANIFEST);
  const b = canonical(candidate);
  if (a !== b) {
    throw new Error("Protocol manifest drift detected — the Layer 4 public surface is frozen");
  }
  return true;
}

/** Deterministic JSON with sorted keys. */
function canonical(obj) {
  return JSON.stringify(obj, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}
