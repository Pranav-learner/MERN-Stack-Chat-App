/**
 * @module crypto-hardening/freeze
 *
 * **Protocol freeze.** Declares the STABLE public cryptographic interfaces of Layers 2–5 and
 * the documented extension points Layer 6 (Peer Discovery) may build on WITHOUT redesigning the
 * cryptographic architecture. This is a machine-readable manifest + compatibility helpers — the
 * authoritative human description lives in `LAYER5_FINAL.md`.
 *
 * @security The freeze fixes interface shapes + wire/derivation versions. Any breaking change to
 * a frozen interface must bump the corresponding version here and be called out as a migration.
 */

/** The frozen wire/derivation versions across the crypto stack (bump = breaking change). */
export const FROZEN_VERSIONS = Object.freeze({
  cryptoSdk: "1.0.0",
  handshakeProtocol: "1.0",
  sessionSchema: 1,
  forwardSecrecyChain: 1, // FS_CHAIN_VERSION
  keyHierarchy: 1, // KH_VERSION
  messageKeys: 1, // MK_VERSION
  transportEnvelope: 1, // PAYLOAD_ENVELOPE_VERSION
  messageEnvelope: 1, // MK_ENVELOPE_VERSION
});

/**
 * The frozen public interfaces — module → the stable exported symbols Layer 6 may depend on.
 * Adding to a list is backward-compatible; removing/renaming is a breaking change.
 */
export const FROZEN_INTERFACES = Object.freeze({
  "crypto-sdk": ["hkdf", "aead (SymmetricEngine)", "x25519", "signatures"],
  identity: ["identityContextService", "verifyToken", "attachSocketIdentity"],
  "shs (handshake)": ["HandshakeManager", "state machine", "key-agreement (X25519 ECDH)"],
  "shs/session": ["SecureSessionManager", "SessionEventBus", "SecureKeyStore"],
  "secure-transport": ["SecureTransportManager", "encryptMessage", "decryptMessage", "SecurePayload"],
  "session-evolution": ["EvolutionManager", "policies", "EvolutionScheduler"],
  "forward-secrecy": ["ForwardSecrecyManager", "evolve", "resolveEncryptionKeys/resolveDecryptionKeys"],
  "evolution-policy": ["AutomaticRekeyManager", "policy factories", "RekeyExecutionEngine"],
  "key-hierarchy": ["ChainManager", "resolveSendingChainKey/resolveReceivingChainKey", "messageKeyLabel"],
  "message-keys": ["MessageKeyManager", "sealMessage/openMessage", "MessageKeyCache"],
  "crypto-hardening": ["ReplayGuard", "MetricsRegistry", "SecurityMonitor", "RecoveryCoordinator", "KeyLifecycleVerifier"],
});

/**
 * The documented extension points for Layer 6 — the seams to build on without touching the
 * frozen crypto. Each names the module, the seam, and what a future layer plugs in.
 */
export const EXTENSION_POINTS = Object.freeze([
  { module: "key-hierarchy/derivation", seam: "messageKeyLabel + chain resolution", forLayer: "Post-Compromise Security may add a DH ratchet that reseeds the Root Key" },
  { module: "forward-secrecy", seam: "reserved ratchetMaterial per generation", forLayer: "consumed by the key hierarchy; a DH ratchet can reseed it" },
  { module: "secure-transport/transport", seam: "BaseTransport + adapters (REST/Socket)", forLayer: "Peer Discovery adds P2P/WebRTC transports behind the same interface" },
  { module: "session-integration", seam: "encryption interceptor (setEncryptionInterceptor)", forLayer: "any transport wraps the same seal/open" },
  { module: "crypto-hardening/observability", seam: "MetricsRegistry.registerExporter", forLayer: "Prometheus / OpenTelemetry exporters" },
  { module: "crypto-hardening/monitoring", seam: "SecurityMonitor alert bus", forLayer: "external SIEM / alerting" },
  { module: "*/events", seam: "typed event buses", forLayer: "Layer 6 consumes lifecycle + hardening events" },
]);

/**
 * Whether a peer's declared versions are compatible with the frozen stack. A component is
 * compatible when its version equals the frozen version (same-major policy for this sprint).
 * @param {Partial<typeof FROZEN_VERSIONS>} versions @returns {{ compatible: boolean, mismatches: string[] }}
 */
export function assertCompatible(versions = {}) {
  const mismatches = [];
  for (const [k, v] of Object.entries(versions)) {
    if (k in FROZEN_VERSIONS && FROZEN_VERSIONS[k] !== v) mismatches.push(`${k}: expected ${FROZEN_VERSIONS[k]}, got ${v}`);
  }
  return { compatible: mismatches.length === 0, mismatches };
}

/** The full, serializable protocol-freeze manifest (for `/api/crypto-hardening/protocol`). */
export function protocolManifest() {
  return {
    frozen: true,
    versions: { ...FROZEN_VERSIONS },
    interfaces: { ...FROZEN_INTERFACES },
    extensionPoints: EXTENSION_POINTS.map((e) => ({ ...e })),
    note: "Layers 2–5 cryptographic interfaces are frozen. Layer 6 (Peer Discovery) builds on the extension points without redesigning the cryptography.",
  };
}
