/**
 * @module shs/hardening/audit/securityAudit
 *
 * A machine-readable security audit of the Secure Handshake System. Each control is
 * evaluated against the wired configuration and reported as `implemented`, `partial`,
 * or `future` (deferred to a later layer), with an assumption/notes string. The doc
 * (`LAYER4_FINAL.md`) renders this; CI can assert no control regressed to `missing`.
 *
 * @security This is an INVENTORY, not an enforcement point. It documents what the
 * protocol does and — importantly — its assumptions and known limitations.
 */

/** @readonly @enum {string} */
export const ControlStatus = Object.freeze({
  IMPLEMENTED: "implemented",
  PARTIAL: "partial",
  FUTURE: "future",
  MISSING: "missing",
});

/**
 * Produce the security audit report.
 * @param {object} [config] optional flags describing what is wired
 * @param {boolean} [config.replayProtection=true]
 * @param {boolean} [config.downgradeProtection=true]
 * @param {boolean} [config.authenticatedKeyExchange=false] whether ephemeral keys are identity-signed
 * @param {boolean} [config.sessionGuard=true]
 * @returns {{ generatedFor: string, controls: Array<object>, summary: object, assumptions: string[] }}
 */
export function securityAudit(config = {}) {
  const s = ControlStatus;
  const replay = config.replayProtection ?? true;
  const downgrade = config.downgradeProtection ?? true;
  const authKe = config.authenticatedKeyExchange ?? false;
  const guard = config.sessionGuard ?? true;

  const controls = [
    {
      control: "MITM resistance",
      status: authKe ? s.IMPLEMENTED : s.PARTIAL,
      area: "key-agreement",
      notes: authKe
        ? "Ephemeral keys are Ed25519-signed by the identity key and verified against the Layer 3 directory."
        : "Ephemeral keys MAY be identity-signed (optional). Without mandatory signing, MITM protection relies on Layer 3 out-of-band identity verification + shared-secret commitment comparison.",
    },
    {
      control: "Replay resistance",
      status: replay ? s.IMPLEMENTED : s.PARTIAL,
      area: "hardening/replay",
      notes: "Nonce + messageId tracking in a TTL replay cache, timestamp freshness window, and per-handshake-id first-use. Cache TTL aligns to the timestamp window to bound memory.",
    },
    {
      control: "Downgrade resistance",
      status: downgrade ? s.IMPLEMENTED : s.PARTIAL,
      area: "hardening/downgrade",
      notes: "Reject-below-minimum + insecure-version denylist, max-common-version validation, capability/algorithm strip detection, and a transcript hash for tamper-evidence. Transcript is not yet cryptographically signed (no signed handshake) — tampering is DETECTABLE, not prevented, until a future authenticated binding.",
    },
    {
      control: "Identity validation",
      status: s.IMPLEMENTED,
      area: "layer-3 + session-guard",
      notes: "Handshake parties and session participants/devices resolve against the Layer 3 identity + device directories; the SessionGuard re-checks on every use.",
    },
    {
      control: "Session isolation",
      status: s.IMPLEMENTED,
      area: "session/derivation",
      notes: "Session keys are context-separated (bound to handshakeId + sorted participants + devices) and purpose-separated (distinct HKDF label per key). Distinct handshakes ⇒ distinct keys.",
    },
    {
      control: "Key lifecycle",
      status: s.IMPLEMENTED,
      area: "key-agreement + session",
      notes: "Ephemeral keys are fresh per handshake, never reused, destroyed after derivation. Session keys live device-local, are wiped on close/destroy, and are never persisted server-side.",
    },
    {
      control: "Error handling",
      status: s.IMPLEMENTED,
      area: "all",
      notes: "Typed error hierarchies per subsystem (ERR_SHS_/ERR_KA_/ERR_SESSION_/ERR_HARDENING_) with stable codes + HTTP status; controllers translate to safe JSON without leaking internals.",
    },
    {
      control: "Serialization safety",
      status: s.IMPLEMENTED,
      area: "shs/serializers + hardening/integrity",
      notes: "Framed binary with magic + CRC32 integrity + length checks; JSON size caps; header/ordering/state-consistency validation; a chained transcript over the message stream.",
    },
    {
      control: "Temporary key destruction",
      status: s.IMPLEMENTED,
      area: "key-agreement + session/storage",
      notes: "Ephemeral private keys dropped post-derivation; transient secret Buffers/Uint8Arrays zero-filled on dispose/close/logout.",
    },
    {
      control: "Memory cleanup",
      status: s.PARTIAL,
      area: "storage",
      notes: "Secret buffers are zero-filled; however the JS runtime may retain copies of KeyObject/CryptoKey internal bytes that cannot be force-wiped. Raw private bytes are never exported.",
    },
    {
      control: "State-machine integrity",
      status: s.IMPLEMENTED,
      area: "shs/state-machine + session/lifecycle",
      notes: "Deterministic FSMs; every transition validated in the manager AND re-checkable via hardening/integrity. Terminal states are immutable.",
    },
    {
      control: "Continuous session validation",
      status: guard ? s.IMPLEMENTED : s.FUTURE,
      area: "hardening/session-guard",
      notes: "Ownership, participant/device identity, metadata, expiration, protocol compatibility, and trust state are re-validated before each session use.",
    },
    {
      control: "Forward secrecy",
      status: s.FUTURE,
      area: "layer-5",
      notes: "Out of scope for Layer 4 by design. The rekey framework + ratchet material are in place for Layer 5 to add a ratchet.",
    },
    {
      control: "Message confidentiality",
      status: s.FUTURE,
      area: "layer-5",
      notes: "Out of scope. Session encryption/MAC keys are derived and available (device-local) for Layer 5 to consume.",
    },
  ];

  const summary = controls.reduce((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});

  return {
    generatedFor: "Layer 4 — Secure Handshake System",
    controls,
    summary,
    assumptions: [
      "The transport carries public protocol metadata; confidentiality/authentication of the transport is a future concern (Layer 5 / TLS).",
      "Layer 3 identity keys are authentic (established out-of-band / via the verification flow).",
      "The server is honest-but-curious: it relays public material and stores metadata; it never receives private keys or shared secrets and cannot derive session keys.",
      "Clocks across peers are within the configured skew window (default 30s) for timestamp-based replay bounds.",
      "A single-node in-process replay cache; multi-node deployments must share a distributed replay store (documented extension point).",
    ],
  };
}
