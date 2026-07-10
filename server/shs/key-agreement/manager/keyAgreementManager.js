/**
 * @module shs/key-agreement/manager
 *
 * The **Key Agreement Manager** — the reusable facade for Secure Key Agreement
 * (Layer 4, Sprint 2). It plugs cryptographic key agreement INTO the Sprint 1
 * Secure Handshake System without redesigning it: after the handshake reaches
 * `negotiating`, this manager drives the crypto sub-lifecycle
 * (`generating_ephemeral_keys → waiting_for_peer_key → deriving_shared_secret →
 * shared_secret_established → cryptographically_complete`) and establishes a shared
 * secret between two verified devices.
 *
 * ## Two modes
 * - **Relay / coordination** (server): records the two parties' ephemeral PUBLIC
 *   keys + one-way commitments, negotiates the algorithm, drives the handshake
 *   state, and verifies the commitments match. Needs only the `exchanges` repo.
 *   NEVER sees a private key or the shared secret.
 * - **Device** (client / reference / tests): additionally generates ephemeral keys,
 *   derives the shared secret locally, and stores session material. Needs the
 *   `material` repo + an {@link EphemeralKeyStore}.
 *
 * @security The shared secret is derived independently on each device and is NEVER
 * transmitted. Only PUBLIC ephemeral keys and one-way commitments cross the network.
 * This sprint stores the raw shared secret only — it derives NO encryption keys.
 *
 * @example Relay (server)
 * ```js
 * const ka = new KeyAgreementManager({ ...createMongoKeyAgreementRepositories(), sessions });
 * await ka.negotiate(handshakeId, { initiator, responder });
 * await ka.submitEphemeralKey(handshakeId, "initiator", bundleFromAlice);
 * await ka.submitEphemeralKey(handshakeId, "responder", bundleFromBob);
 * await ka.submitCommitment(handshakeId, "initiator", aliceCommitment);
 * await ka.submitCommitment(handshakeId, "responder", bobCommitment); // → established
 * ```
 */

import crypto from "node:crypto";
import { HandshakeState } from "../../types.js";
import { assertTransition } from "../../state-machine/stateMachine.js";
import {
  ExchangeState,
  KeyAgreementRole,
  KeyAgreementEventType,
  KeyAgreementFailureReason,
  peerRole,
  CRYPTO_PROTOCOL_VERSION,
} from "../types.js";
import {
  KeyAgreementValidationError,
  ExchangeNotFoundError,
  SharedSecretMismatchError,
} from "../errors.js";
import { EphemeralKeyStore } from "../exchange/ephemeralKeys.js";
import { deriveSecret, disposeSecret } from "../derivation/sharedSecret.js";
import { negotiateCrypto, cryptoCapabilities } from "../negotiation/cryptoNegotiation.js";
import {
  validatePeers,
  validateHandshakeRef,
  validateBundle,
  verifyBundleSignature,
  validateAgainstExchange,
  assertNotDuplicateKey,
  assertNotReplayedKey,
  assertExchangeFresh,
} from "../validation/keyAgreementValidators.js";
import { createSessionMaterial, materialSecretBytes } from "../session/sessionMaterial.js";
import { toPublicExchange, toPublicSessionMaterial } from "../serialization/keyAgreementSerializer.js";
import { KeyAgreementEventBus } from "../events/keyAgreementEvents.js";
import { DEFAULT_HANDSHAKE_TTL_MS } from "../../protocol/constants.js";

/** The ordered SHS crypto sub-lifecycle (used to sync the handshake state forward). */
const KA_CHAIN = [
  HandshakeState.NEGOTIATING,
  HandshakeState.GENERATING_EPHEMERAL_KEYS,
  HandshakeState.WAITING_FOR_PEER_KEY,
  HandshakeState.DERIVING_SHARED_SECRET,
  HandshakeState.SHARED_SECRET_ESTABLISHED,
  HandshakeState.CRYPTOGRAPHICALLY_COMPLETE,
];

export class KeyAgreementManager {
  /**
   * @param {object} deps
   * @param {object} deps.exchanges PUBLIC key-exchange repository (required)
   * @param {object} [deps.material] device-local session-material repository (device mode)
   * @param {EphemeralKeyStore} [deps.ephemeral] device-local ephemeral key store
   * @param {object} [deps.sessions] SHS session repository (drives the handshake state)
   * @param {KeyAgreementEventBus} [deps.events]
   * @param {(userId: string) => Promise<object|null>} [deps.identityLookup]
   * @param {(userId: string, deviceId: string) => Promise<object|null>} [deps.deviceLookup]
   * @param {() => number} [deps.clock] @param {() => string} [deps.idGenerator]
   * @param {number} [deps.ttlMs] key-exchange lifetime
   * @param {boolean} [deps.requireSignature] require authenticated (signed) ephemeral keys
   * @param {string[]} [deps.supportedAlgorithms]
   */
  constructor(deps) {
    if (!deps || !deps.exchanges) throw new Error("KeyAgreementManager requires { exchanges }");
    this.exchanges = deps.exchanges;
    this.material = deps.material ?? null;
    this.sessions = deps.sessions ?? null;
    this.events = deps.events ?? new KeyAgreementEventBus();
    this.identityLookup = deps.identityLookup ?? null;
    this.deviceLookup = deps.deviceLookup ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
    this.ttlMs = deps.ttlMs ?? DEFAULT_HANDSHAKE_TTL_MS;
    this.requireSignature = deps.requireSignature ?? false;
    this.supportedAlgorithms = deps.supportedAlgorithms;
    this.ephemeral = deps.ephemeral ?? new EphemeralKeyStore({ clock: this.clock });
  }

  // === coordination / relay (public only) =================================

  /**
   * Negotiate the key-agreement algorithm + crypto version and open a key-exchange
   * record. Advances the handshake `negotiating → generating_ephemeral_keys`.
   *
   * @param {string} handshakeId
   * @param {object} params
   * @param {string} params.initiator @param {string} params.responder
   * @param {import("../negotiation/cryptoNegotiation.js").CryptoOffer} [params.initiatorOffer]
   * @param {import("../negotiation/cryptoNegotiation.js").CryptoOffer} [params.responderOffer]
   * @param {object} [params.metadata]
   * @returns {Promise<object>} the public exchange DTO
   * @throws {CryptoNegotiationError | UnknownPeerError | KeyAgreementValidationError}
   */
  async negotiate(handshakeId, params) {
    validateHandshakeRef(handshakeId);
    await validatePeers(params, { identityLookup: this.identityLookup, deviceLookup: this.deviceLookup });

    let result;
    try {
      result = negotiateCrypto(params.initiatorOffer ?? {}, params.responderOffer ?? {}, {
        supportedAlgorithms: this.supportedAlgorithms,
      });
    } catch (error) {
      this.events.emit(KeyAgreementEventType.NEGOTIATION_FAILED, {
        handshakeId,
        reason: KeyAgreementFailureReason.ALGORITHM_MISMATCH,
      });
      throw error;
    }

    const nowMs = this.clock();
    const record = {
      handshakeId: String(handshakeId),
      initiator: String(params.initiator),
      responder: String(params.responder),
      algorithm: result.algorithm,
      cryptoVersion: result.cryptoVersion,
      initiatorKey: undefined,
      responderKey: undefined,
      initiatorCommitment: undefined,
      responderCommitment: undefined,
      state: ExchangeState.AWAITING_INITIATOR_KEY,
      metadata: params.metadata ?? {},
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.ttlMs).toISOString(),
    };
    await this.exchanges.create(record);
    await this._syncHandshakeState(handshakeId, HandshakeState.GENERATING_EPHEMERAL_KEYS);

    this.events.emit(KeyAgreementEventType.NEGOTIATION_SUCCEEDED, {
      handshakeId,
      algorithm: result.algorithm,
      details: { cryptoVersion: result.cryptoVersion },
    });
    return toPublicExchange(record);
  }

  /**
   * Record a party's ephemeral PUBLIC key. Validates the key (length + small-order
   * rejection + optional identity signature), guards against duplicates/replays, and
   * advances the handshake state as the exchange progresses.
   *
   * @param {string} handshakeId @param {string} role "initiator" | "responder"
   * @param {import("../types.js").EphemeralPublicKeyBundle} bundle
   * @returns {Promise<object>} the public exchange DTO
   * @throws {InvalidPublicKeyError | DuplicateExchangeError | ReplayError | PeerAuthenticationError}
   */
  async submitEphemeralKey(handshakeId, role, bundle) {
    this._assertRole(role);
    const exchange = await this._requireExchange(handshakeId);
    assertExchangeFresh(exchange, this.clock());
    validateAgainstExchange(bundle, exchange);
    validateBundle(bundle, { requireSignature: this.requireSignature });
    verifyBundleSignature(bundle, { requireSignature: this.requireSignature });
    assertNotReplayedKey(exchange, bundle);
    assertNotDuplicateKey(exchange, role);

    const patch = { [role === KeyAgreementRole.INITIATOR ? "initiatorKey" : "responderKey"]: sanitizeBundle(bundle) };
    const bothKeys =
      (role === KeyAgreementRole.INITIATOR ? bundle : exchange.initiatorKey) &&
      (role === KeyAgreementRole.RESPONDER ? bundle : exchange.responderKey);
    patch.state = bothKeys
      ? ExchangeState.KEYS_EXCHANGED
      : role === KeyAgreementRole.INITIATOR
        ? ExchangeState.AWAITING_RESPONDER_KEY
        : ExchangeState.AWAITING_INITIATOR_KEY;

    const updated = await this.exchanges.update(handshakeId, patch);

    // Advance the handshake: first key → waiting_for_peer_key; both keys → deriving.
    await this._syncHandshakeState(
      handshakeId,
      bothKeys ? HandshakeState.DERIVING_SHARED_SECRET : HandshakeState.WAITING_FOR_PEER_KEY,
    );

    this.events.emit(KeyAgreementEventType.EPHEMERAL_KEY_GENERATED, {
      handshakeId,
      role,
      algorithm: bundle.algorithm,
    });
    if (bothKeys) {
      this.events.emit(KeyAgreementEventType.PEER_KEY_RECEIVED, { handshakeId, role: peerRole(role) });
    }
    return toPublicExchange(updated);
  }

  /**
   * The peer's ephemeral PUBLIC key bundle (for a device to fetch and derive
   * against). Returns null if the peer hasn't submitted yet.
   * @param {string} handshakeId @param {string} role the CALLER's role
   * @returns {Promise<object|null>}
   */
  async getPeerKey(handshakeId, role) {
    this._assertRole(role);
    const exchange = await this._requireExchange(handshakeId);
    const peer = peerRole(role);
    const bundle = peer === KeyAgreementRole.INITIATOR ? exchange.initiatorKey : exchange.responderKey;
    return bundle ? sanitizeBundle(bundle) : null;
  }

  /**
   * Record a party's one-way commitment to its derived secret. When both parties'
   * commitments are present they are compared in constant time: on a match the
   * exchange is `established` and the handshake becomes `cryptographically_complete`;
   * on a mismatch the exchange + handshake FAIL.
   *
   * @param {string} handshakeId @param {string} role @param {string} commitment hex
   * @returns {Promise<object>} the public exchange DTO
   * @throws {SharedSecretMismatchError}
   */
  async submitCommitment(handshakeId, role, commitment) {
    this._assertRole(role);
    if (typeof commitment !== "string" || !/^[0-9a-f]{64}$/i.test(commitment)) {
      throw new KeyAgreementValidationError("Commitment must be a 64-hex-char SHA-256 digest");
    }
    const exchange = await this._requireExchange(handshakeId);
    assertExchangeFresh(exchange, this.clock());
    if (exchange.state !== ExchangeState.KEYS_EXCHANGED && !this._oneCommitmentPresent(exchange)) {
      throw new KeyAgreementValidationError("Both ephemeral keys must be exchanged before committing", {
        details: { state: exchange.state },
      });
    }

    const field = role === KeyAgreementRole.INITIATOR ? "initiatorCommitment" : "responderCommitment";
    let updated = await this.exchanges.update(handshakeId, { [field]: commitment });

    // First commitment → shared_secret_established; second (matching) → complete.
    await this._syncHandshakeState(handshakeId, HandshakeState.SHARED_SECRET_ESTABLISHED);

    if (updated.initiatorCommitment && updated.responderCommitment) {
      const match = crypto.timingSafeEqual(
        Buffer.from(updated.initiatorCommitment, "hex"),
        Buffer.from(updated.responderCommitment, "hex"),
      );
      if (!match) {
        updated = await this.exchanges.update(handshakeId, { state: ExchangeState.FAILED });
        await this._failHandshake(handshakeId);
        this.events.emit(KeyAgreementEventType.KEY_AGREEMENT_FAILED, {
          handshakeId,
          reason: KeyAgreementFailureReason.SECRET_MISMATCH,
        });
        throw new SharedSecretMismatchError();
      }
      updated = await this.exchanges.update(handshakeId, { state: ExchangeState.ESTABLISHED });
      await this._syncHandshakeState(handshakeId, HandshakeState.CRYPTOGRAPHICALLY_COMPLETE);
      this.events.emit(KeyAgreementEventType.KEY_AGREEMENT_COMPLETED, {
        handshakeId,
        fingerprint: commitment,
      });
    }
    return toPublicExchange(updated);
  }

  /** The public key-exchange DTO for a handshake. */
  async getExchange(handshakeId) {
    return toPublicExchange(await this._requireExchange(handshakeId));
  }

  /** List the key exchanges a user is a party to (public DTOs). */
  async listExchanges(userId) {
    return (await this.exchanges.listByUser(userId)).map((e) => toPublicExchange(e));
  }

  /**
   * Fail every active key-exchange record past its deadline. Delegates to guarded
   * transitions and emits failure events.
   * @returns {Promise<{ failed: number, handshakeIds: string[] }>}
   */
  async sweepExpired() {
    const all = await this.exchanges.listAll();
    const now = this.clock();
    const stale = all.filter(
      (e) => e.state !== ExchangeState.ESTABLISHED && e.state !== ExchangeState.FAILED && e.expiresAt && new Date(e.expiresAt).getTime() <= now,
    );
    const handshakeIds = [];
    for (const e of stale) {
      try {
        await this.exchanges.update(e.handshakeId, { state: ExchangeState.FAILED });
        await this._failHandshake(e.handshakeId);
        this.events.emit(KeyAgreementEventType.KEY_AGREEMENT_FAILED, {
          handshakeId: e.handshakeId,
          reason: KeyAgreementFailureReason.EXPIRED,
        });
        handshakeIds.push(e.handshakeId);
      } catch {
        /* concurrently terminated — skip */
      }
    }
    return { failed: handshakeIds.length, handshakeIds };
  }

  // === device operations (require material + ephemeral stores) ============

  /**
   * Generate a fresh ephemeral X25519 key pair for a (handshake, role), keeping the
   * private key in the local store. Returns the PUBLIC bundle to publish via the relay.
   * @param {string} handshakeId @param {string} role
   * @param {{ identityPrivateKey?: import("crypto").KeyObject, identityPublicKey?: string }} [options]
   * @returns {import("../types.js").EphemeralPublicKeyBundle}
   */
  generateEphemeralKeys(handshakeId, role, options = {}) {
    this._assertRole(role);
    const bundle = this.ephemeral.generate(handshakeId, role, options);
    this.events.emit(KeyAgreementEventType.EPHEMERAL_KEY_GENERATED, {
      handshakeId,
      role,
      algorithm: bundle.algorithm,
      fingerprint: bundle.keyId,
    });
    return bundle;
  }

  /**
   * Derive the shared secret against a peer's ephemeral public key, store session
   * material locally, and destroy the ephemeral private key. Returns the PUBLIC
   * material DTO + the one-way commitment to publish.
   *
   * @param {string} handshakeId @param {string} role
   * @param {Buffer|string} peerPublicKey peer ephemeral public key (raw / base64)
   * @param {{ algorithm?: string, cryptoVersion?: string, metadata?: object, ttlMs?: number }} [options]
   * @returns {Promise<{ material: object, commitment: string }>}
   * @throws {InvalidPublicKeyError | SharedSecretError}
   */
  async deriveAndStore(handshakeId, role, peerPublicKey, options = {}) {
    this._assertRole(role);
    this._requireDeviceMode();
    const privateKey = this.ephemeral.privateKey(handshakeId, role);

    const { secret, commitment } = deriveSecret(privateKey, peerPublicKey);
    try {
      const material = createSessionMaterial({
        handshakeId,
        sharedSecret: secret,
        fingerprint: commitment,
        algorithm: options.algorithm ?? "x25519",
        cryptoVersion: options.cryptoVersion ?? CRYPTO_PROTOCOL_VERSION,
        metadata: options.metadata,
        ttlMs: options.ttlMs,
        ephemeralDestroyed: true,
        clock: this.clock,
        idGenerator: this.idGenerator,
      });
      await this.material.create(material);
      this.events.emit(KeyAgreementEventType.SHARED_SECRET_DERIVED, { handshakeId, role, fingerprint: commitment });
      this.events.emit(KeyAgreementEventType.SESSION_MATERIAL_CREATED, {
        handshakeId,
        role,
        fingerprint: commitment,
      });
      return { material: toPublicSessionMaterial(material), commitment };
    } finally {
      // Dispose of the transient secret buffer and destroy the ephemeral private key.
      disposeSecret(secret);
      this.destroyEphemeralKeys(handshakeId, role);
    }
  }

  /**
   * The device-local raw shared secret for a handshake (a Buffer). For local use by a
   * FUTURE sprint (session-key derivation) ONLY — never returned by any API.
   * @param {string} handshakeId @returns {Promise<Buffer>}
   * @throws {SessionMaterialNotFoundError}
   */
  async loadSharedSecret(handshakeId) {
    this._requireDeviceMode();
    const material = await this.material.requireByHandshake(handshakeId);
    return materialSecretBytes(material);
  }

  /** The PUBLIC session-material DTO for a handshake (no secret). */
  async getSessionMaterial(handshakeId) {
    this._requireDeviceMode();
    const material = await this.material.findByHandshake(handshakeId);
    return material ? toPublicSessionMaterial(material) : null;
  }

  /** Destroy the local ephemeral key(s) for a handshake. */
  destroyEphemeralKeys(handshakeId, role = null) {
    const removed = role ? this.ephemeral.destroy(handshakeId, role) : this.ephemeral.destroyHandshake(handshakeId);
    if (removed) {
      this.events.emit(KeyAgreementEventType.EPHEMERAL_KEYS_DESTROYED, { handshakeId, role: role ?? "all" });
    }
    return removed;
  }

  /** Delete the local session material for a handshake (device-local). */
  async deleteSessionMaterial(handshakeId) {
    this._requireDeviceMode();
    return this.material.deleteByHandshake(handshakeId);
  }

  /** This build's advertised crypto capabilities. */
  capabilities() {
    return cryptoCapabilities();
  }

  // === internals ==========================================================

  /** @private @throws {ExchangeNotFoundError} */
  async _requireExchange(handshakeId) {
    validateHandshakeRef(handshakeId);
    const exchange = await this.exchanges.findById(handshakeId);
    if (!exchange) throw new ExchangeNotFoundError("Exchange not found", { details: { handshakeId } });
    return exchange;
  }

  /** @private */
  _oneCommitmentPresent(exchange) {
    return !!(exchange.initiatorCommitment || exchange.responderCommitment);
  }

  /** @private Require device mode (material + ephemeral stores present). */
  _requireDeviceMode() {
    if (!this.material) {
      throw new KeyAgreementValidationError(
        "This operation requires device mode (a session-material repository). The server relay does not derive or store secrets.",
      );
    }
  }

  /** @private */
  _assertRole(role) {
    if (role !== KeyAgreementRole.INITIATOR && role !== KeyAgreementRole.RESPONDER) {
      throw new KeyAgreementValidationError(`Invalid role: ${role}`, { details: { role } });
    }
  }

  /**
   * @private Advance the SHS handshake session forward along the crypto chain to
   * `targetState` (walking one legal step at a time). No-op when there is no SHS
   * session repo, the session is missing, or it is not on the crypto chain.
   */
  async _syncHandshakeState(handshakeId, targetState) {
    if (!this.sessions) return;
    const session = await this.sessions.findById(handshakeId);
    if (!session) return;
    const currentIndex = KA_CHAIN.indexOf(session.state);
    const targetIndex = KA_CHAIN.indexOf(targetState);
    if (currentIndex < 0 || targetIndex < 0 || targetIndex <= currentIndex) return;

    let state = session.state;
    const history = [...(session.history ?? [])];
    for (let i = currentIndex + 1; i <= targetIndex; i++) {
      const next = KA_CHAIN[i];
      assertTransition(state, next);
      history.push({ from: state, to: next, at: new Date(this.clock()).toISOString(), reason: "key-agreement" });
      state = next;
    }
    const patch = { state, history, updatedAt: new Date(this.clock()).toISOString() };
    if (state === HandshakeState.CRYPTOGRAPHICALLY_COMPLETE) patch.completedAt = new Date(this.clock()).toISOString();
    await this.sessions.update(handshakeId, patch);
  }

  /** @private Transition the SHS session to FAILED (if present and legal). */
  async _failHandshake(handshakeId) {
    if (!this.sessions) return;
    const session = await this.sessions.findById(handshakeId);
    if (!session || !KA_CHAIN.includes(session.state)) return;
    try {
      assertTransition(session.state, HandshakeState.FAILED);
    } catch {
      return;
    }
    const now = new Date(this.clock()).toISOString();
    await this.sessions.update(handshakeId, {
      state: HandshakeState.FAILED,
      completedAt: now,
      updatedAt: now,
      history: [...(session.history ?? []), { from: session.state, to: HandshakeState.FAILED, at: now, reason: "key-agreement-failed" }],
    });
  }
}

/** Strip an ephemeral bundle to its stored PUBLIC fields. */
function sanitizeBundle(bundle) {
  return {
    algorithm: bundle.algorithm,
    publicKey: bundle.publicKey,
    keyId: bundle.keyId,
    version: bundle.version,
    signature: bundle.signature,
    identityPublicKey: bundle.identityPublicKey,
    createdAt: bundle.createdAt,
  };
}
