/**
 * @module key-hierarchy/manager
 *
 * The **Chain Manager** — the reusable facade for the key hierarchy (Layer 5, Sprint 4). It
 * establishes a session's Root Key + sending/receiving chains, advances each chain
 * independently, re-roots the hierarchy when the session rekeys, validates chain integrity,
 * and exposes the current chain state. The raw keys live entirely in the device key store;
 * this manager keeps the metadata repository, audit trail, and events in sync.
 *
 * ## Two modes (mirrors the other Layer 5 managers)
 * - **Device mode** — constructed with a {@link KeyHierarchyKeyStore}. `establish` /
 *   `advanceSendingChain` / `advanceReceivingChain` / `reroot` derive + ratchet real key
 *   material; `resolveSendingChainKey` / `resolveReceivingChainKey` feed a FUTURE per-message
 *   key deriver + Secure Transport. Keys never leave the device.
 * - **Descriptor mode** (server) — no key store; tracks the hierarchy METADATA a device
 *   reported. Read-only + `register`/`recordAdvance` for metadata.
 *
 * @security This IS a cryptographic component. Secrets live ONLY in the device key store;
 * repositories, DTOs, events, and audit records carry METADATA only. Advancing a chain is
 * one-way (forward-secret at the chain level); re-rooting archives + destroys the old chains.
 *
 * @hierarchy Sprint 4 builds the hierarchy; it does NOT derive per-message keys. The message
 * key is a Sprint 5 extension hung off {@link resolveSendingChainKey}.
 *
 * @example Device
 * ```js
 * const chains = new ChainManager({ ...createInMemoryKeyHierarchyRepository(), keyStore: new KeyHierarchyKeyStore() });
 * await chains.establish({ sessionId, handshakeId, role: "initiator", rootSecret });
 * await chains.advanceSendingChain(sessionId);   // ratchet the sending chain (no message key yet)
 * ```
 */

import {
  KeyHierarchyEventType,
  RootKeyStatus,
  ChainRole,
  DeviceRole,
  INITIAL_GENERATION,
  KH_SCHEMA_VERSION,
} from "../types/types.js";
import { KeyStoreRequiredError, HierarchyStateError } from "../errors.js";
import { deriveRootKey, deriveChainKey, directionsForRole, disposeKey } from "../derivation/derivation.js";
import { createRootKeyMeta, supersedeRootKey } from "../root/rootKey.js";
import { createChainMeta, advanceChainMeta, archiveChainMeta } from "../chains/chain.js";
import { createSecurityMetadata, recomputeMetadata } from "../metadata/metadata.js";
import { auditEntry, appendAudit, AuditAction } from "../audit/audit.js";
import {
  validateSessionRef,
  requireHierarchy,
  assertValidRootKey,
  validateHierarchyMetadata,
  validateRepository,
} from "../validators/validators.js";
import { toPublicHierarchy, toHierarchyStatus, toPublicChain, toPublicRootKey } from "../serialization/serializer.js";
import { KeyHierarchyEventBus } from "../events/events.js";

export class ChainManager {
  /**
   * @param {object} deps
   * @param {object} deps.hierarchies hierarchy repository (required)
   * @param {import("../keystore/keyHierarchyKeyStore.js").KeyHierarchyKeyStore} [deps.keyStore] device key store (device mode)
   * @param {KeyHierarchyEventBus} [deps.events] @param {() => number} [deps.clock]
   * @param {(scope: string, error: Error) => void} [deps.onError]
   */
  constructor(deps) {
    if (!deps || !deps.hierarchies) throw new Error("ChainManager requires { hierarchies }");
    this.repo = validateRepository(deps.hierarchies);
    this.keyStore = deps.keyStore ?? null;
    this.events = deps.events ?? new KeyHierarchyEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this._onError = deps.onError ?? ((scope, error) => console.error(`[key-hierarchy] ${scope}:`, error?.message));
  }

  // === establishment =======================================================

  /**
   * Establish the hierarchy for a session: derive the Root Key + sending/receiving chains
   * from a root secret (the Sprint 2 generation's `ratchetMaterial`). DEVICE mode.
   * @param {object} params
   * @param {string} params.sessionId @param {string} [params.handshakeId]
   * @param {string} params.role one of {@link DeviceRole} (decides sending/receiving direction)
   * @param {Buffer|Uint8Array} params.rootSecret device-local root secret
   * @param {number} [params.generation] @param {string[]} [params.participants]
   * @returns {Promise<object>} the public hierarchy DTO
   * @throws {KeyStoreRequiredError | HierarchyStateError}
   */
  async establish(params) {
    if (!this.keyStore) throw new KeyStoreRequiredError("establish requires a device-local key store");
    validateSessionRef(params.sessionId);
    if (await this.repo.findBySessionId(params.sessionId)) {
      throw new HierarchyStateError("Key hierarchy already established for this session", { details: { sessionId: params.sessionId } });
    }
    const role = params.role ?? DeviceRole.INITIATOR;
    const generation = params.generation ?? INITIAL_GENERATION;
    const chainContext = { sessionId: String(params.sessionId), handshakeId: params.handshakeId };
    const derivationContext = { ...chainContext, generation };

    const rootKey = assertValidRootKey(deriveRootKey(params.rootSecret, derivationContext));
    const { sending, receiving } = directionsForRole(role);
    const sendingKey = deriveChainKey(rootKey, sending, derivationContext);
    const receivingKey = deriveChainKey(rootKey, receiving, derivationContext);

    const at = this._iso();
    const rootMeta = createRootKeyMeta(rootKey, { generation, at });
    const sendingChain = createChainMeta(sendingKey, { direction: sending, role: ChainRole.SENDING, generation, at });
    const receivingChain = createChainMeta(receivingKey, { direction: receiving, role: ChainRole.RECEIVING, generation, at });

    this.keyStore.initialize(params.sessionId, rootKey, sendingKey, receivingKey, { chainContext, derivationContext, role });

    const state = {
      sessionId: String(params.sessionId),
      handshakeId: params.handshakeId,
      role,
      generation,
      rootKey: rootMeta,
      sendingChain,
      receivingChain,
      archivedChains: [],
      rootHistory: [rootMeta],
      audit: [
        auditEntry(AuditAction.ROOT_CREATED, { at, generation, rootKeyId: rootMeta.rootKeyId, fingerprint: rootMeta.fingerprint }),
        auditEntry(AuditAction.CHAIN_CREATED, { at, generation, chainId: sendingChain.chainId, direction: sending, role: ChainRole.SENDING }),
        auditEntry(AuditAction.CHAIN_CREATED, { at, generation, chainId: receivingChain.chainId, direction: receiving, role: ChainRole.RECEIVING }),
      ],
      security: createSecurityMetadata(),
      createdAt: at,
      updatedAt: at,
      schemaVersion: KH_SCHEMA_VERSION,
    };
    state.metadata = recomputeMetadata(state);
    await this.repo.create(state);

    this._emit(KeyHierarchyEventType.ROOT_KEY_CREATED, { sessionId: state.sessionId, generation, rootKeyId: rootMeta.rootKeyId, fingerprint: rootMeta.fingerprint });
    this._emit(KeyHierarchyEventType.CHAIN_CREATED, { sessionId: state.sessionId, generation, chainId: sendingChain.chainId, direction: sending, role: ChainRole.SENDING });
    this._emit(KeyHierarchyEventType.CHAIN_CREATED, { sessionId: state.sessionId, generation, chainId: receivingChain.chainId, direction: receiving, role: ChainRole.RECEIVING });
    return toPublicHierarchy(state);
  }

  // === chain evolution =====================================================

  /**
   * Advance the SENDING chain one step (ratchet its key forward; index + 1). Disposes the
   * previous chain key. Does NOT derive a per-message key (Sprint 5). DEVICE mode.
   * @param {string} sessionId @param {{ reason?: string }} [options] @returns {Promise<object>} public DTO
   */
  async advanceSendingChain(sessionId, options = {}) {
    return this._advanceChain(sessionId, ChainRole.SENDING, options);
  }

  /**
   * Advance the RECEIVING chain one step (independent of the sending chain). DEVICE mode.
   * @param {string} sessionId @param {{ reason?: string }} [options] @returns {Promise<object>} public DTO
   */
  async advanceReceivingChain(sessionId, options = {}) {
    return this._advanceChain(sessionId, ChainRole.RECEIVING, options);
  }

  /**
   * Re-root the hierarchy at a new generation (called when the session rekeys via Sprint 2/3):
   * archive the current chains, supersede the root, and derive a fresh root + chains from the
   * new generation's root secret. DEVICE mode.
   * @param {string} sessionId
   * @param {{ rootSecret: Buffer|Uint8Array, generation: number, reason?: string }} params
   * @returns {Promise<object>} public DTO
   */
  async reroot(sessionId, params) {
    if (!this.keyStore) throw new KeyStoreRequiredError("reroot requires a device-local key store");
    const state = requireHierarchy(await this.repo.findBySessionId(sessionId), sessionId);
    const generation = params.generation;
    if (generation <= state.generation) {
      throw new HierarchyStateError(`Re-root generation must advance (current ${state.generation})`, { details: { current: state.generation, next: generation } });
    }
    const ctx = this.keyStore.getContext(sessionId);
    const role = state.role ?? ctx.role;
    const derivationContext = { sessionId: String(sessionId), handshakeId: state.handshakeId, generation };

    const rootKey = assertValidRootKey(deriveRootKey(params.rootSecret, derivationContext));
    const { sending, receiving } = directionsForRole(role);
    const sendingKey = deriveChainKey(rootKey, sending, derivationContext);
    const receivingKey = deriveChainKey(rootKey, receiving, derivationContext);

    const at = this._iso();
    const rootMeta = createRootKeyMeta(rootKey, { generation, version: (state.rootKey?.version ?? 1) + 1, at });
    const sendingChain = createChainMeta(sendingKey, { direction: sending, role: ChainRole.SENDING, generation, version: (state.sendingChain?.version ?? 1) + 1, at });
    const receivingChain = createChainMeta(receivingKey, { direction: receiving, role: ChainRole.RECEIVING, generation, version: (state.receivingChain?.version ?? 1) + 1, at });

    this.keyStore.reroot(sessionId, rootKey, sendingKey, receivingKey);

    const archivedChains = [
      ...(state.archivedChains ?? []),
      archiveChainMeta(state.sendingChain, at),
      archiveChainMeta(state.receivingChain, at),
    ];
    const updated = await this.repo.update(sessionId, {
      generation,
      rootKey: rootMeta,
      sendingChain,
      receivingChain,
      archivedChains,
      rootHistory: [...(state.rootHistory ?? []), rootMeta],
      metadata: recomputeMetadata({ ...state, generation, rootKey: rootMeta, sendingChain, receivingChain, archivedChains }),
      audit: this._audit(state.audit, [
        auditEntry(AuditAction.ROOT_SUPERSEDED, { at, generation: state.generation, rootKeyId: state.rootKey?.rootKeyId }),
        auditEntry(AuditAction.CHAIN_ARCHIVED, { at, chainId: state.sendingChain.chainId, role: ChainRole.SENDING }),
        auditEntry(AuditAction.CHAIN_ARCHIVED, { at, chainId: state.receivingChain.chainId, role: ChainRole.RECEIVING }),
        auditEntry(AuditAction.ROOT_CREATED, { at, generation, rootKeyId: rootMeta.rootKeyId, fingerprint: rootMeta.fingerprint }),
      ]),
      updatedAt: at,
    });

    this._emit(KeyHierarchyEventType.ROOT_KEY_SUPERSEDED, { sessionId: String(sessionId), generation: state.generation, rootKeyId: state.rootKey?.rootKeyId });
    this._emit(KeyHierarchyEventType.CHAIN_ARCHIVED, { sessionId: String(sessionId), chainId: state.sendingChain.chainId, role: ChainRole.SENDING });
    this._emit(KeyHierarchyEventType.CHAIN_ARCHIVED, { sessionId: String(sessionId), chainId: state.receivingChain.chainId, role: ChainRole.RECEIVING });
    this._emit(KeyHierarchyEventType.ROOT_KEY_CREATED, { sessionId: String(sessionId), generation, rootKeyId: rootMeta.rootKeyId, fingerprint: rootMeta.fingerprint });
    this._emit(KeyHierarchyEventType.CHAIN_CREATED, { sessionId: String(sessionId), generation, chainId: sendingChain.chainId, role: ChainRole.SENDING });
    this._emit(KeyHierarchyEventType.CHAIN_CREATED, { sessionId: String(sessionId), generation, chainId: receivingChain.chainId, role: ChainRole.RECEIVING });
    return toPublicHierarchy(updated);
  }

  // === queries =============================================================

  /** Full hierarchy DTO. Emits CHAIN_LOADED. */
  async getState(sessionId) {
    const state = requireHierarchy(await this.repo.findBySessionId(this._id(sessionId)), sessionId);
    this._emit(KeyHierarchyEventType.CHAIN_LOADED, { sessionId: state.sessionId, generation: state.generation });
    return toPublicHierarchy(state);
  }

  /** The DTO, or null if not established. */
  async findState(sessionId) {
    validateSessionRef(sessionId);
    const state = await this.repo.findBySessionId(sessionId);
    return state ? toPublicHierarchy(state) : null;
  }

  /** Compact status (generation + chain indexes). */
  async getStatus(sessionId) {
    return toHierarchyStatus(requireHierarchy(await this.repo.findBySessionId(this._id(sessionId)), sessionId));
  }

  /** The sending chain metadata. */
  async getSendingChain(sessionId) {
    return toPublicChain(requireHierarchy(await this.repo.findBySessionId(this._id(sessionId)), sessionId).sendingChain);
  }

  /** The receiving chain metadata. */
  async getReceivingChain(sessionId) {
    return toPublicChain(requireHierarchy(await this.repo.findBySessionId(this._id(sessionId)), sessionId).receivingChain);
  }

  /** The root-key metadata. */
  async getRootKey(sessionId) {
    return toPublicRootKey(requireHierarchy(await this.repo.findBySessionId(this._id(sessionId)), sessionId).rootKey);
  }

  /** The audit trail. */
  async getAudit(sessionId) {
    return requireHierarchy(await this.repo.findBySessionId(this._id(sessionId)), sessionId).audit.map((a) => ({ ...a }));
  }

  // === validation ==========================================================

  /**
   * Validate the hierarchy: metadata shape, no key material, and (device mode) that the key
   * store's chain indexes match the metadata. Emits CHAIN_VALIDATED.
   * @param {string} sessionId @returns {Promise<{ valid: boolean, reason?: string }>}
   */
  async validate(sessionId) {
    const state = requireHierarchy(await this.repo.findBySessionId(this._id(sessionId)), sessionId);
    try {
      validateHierarchyMetadata(state);
      if (this.keyStore && this.keyStore.has(sessionId)) {
        if (this.keyStore.sendingIndex(sessionId) !== state.sendingChain.index) throw new Error("sending index mismatch");
        if (this.keyStore.receivingIndex(sessionId) !== state.receivingChain.index) throw new Error("receiving index mismatch");
      }
    } catch (error) {
      return { valid: false, reason: error.code ?? error.message };
    }
    this._emit(KeyHierarchyEventType.CHAIN_VALIDATED, { sessionId: state.sessionId, generation: state.generation });
    return { valid: true };
  }

  // === transport key resolution (DEVICE mode) =============================

  /**
   * The CURRENT sending chain key (device-local). This is the extension point a FUTURE
   * sprint derives per-message keys from. NEVER exposed via any API.
   * @param {string} sessionId @returns {{ chainKey: Buffer, index: number, chainKeyId: string }}
   * @throws {KeyStoreRequiredError}
   */
  resolveSendingChainKey(sessionId) {
    return this._resolveChainKey(sessionId, "sending");
  }

  /**
   * The CURRENT receiving chain key (device-local). Extension point for FUTURE per-message
   * key derivation on the receive side. NEVER exposed via any API.
   * @param {string} sessionId @returns {{ chainKey: Buffer, index: number, chainKeyId: string }}
   */
  resolveReceivingChainKey(sessionId) {
    return this._resolveChainKey(sessionId, "receiving");
  }

  // === teardown ============================================================

  /** Destroy all key material + mark the hierarchy destroyed. Emits HIERARCHY_DESTROYED. */
  async destroy(sessionId, options = {}) {
    const state = requireHierarchy(await this.repo.findBySessionId(this._id(sessionId)), sessionId);
    if (this.keyStore) this.keyStore.destroySession(sessionId);
    const at = this._iso();
    const dead = (c) => (c ? { ...c, status: "destroyed", destroyedAt: at } : c);
    const updated = await this.repo.update(sessionId, {
      rootKey: { ...state.rootKey, status: RootKeyStatus.DESTROYED, destroyedAt: at },
      sendingChain: dead(state.sendingChain),
      receivingChain: dead(state.receivingChain),
      audit: appendAudit(state.audit, auditEntry(AuditAction.HIERARCHY_DESTROYED, { at, reason: options.reason })),
      updatedAt: at,
    });
    this._emit(KeyHierarchyEventType.HIERARCHY_DESTROYED, { sessionId: String(sessionId), generation: state.generation });
    return toPublicHierarchy(updated);
  }

  /** Delete the hierarchy metadata record entirely (housekeeping). */
  async deleteState(sessionId) {
    validateSessionRef(sessionId);
    if (this.keyStore) this.keyStore.destroySession(sessionId);
    return { sessionId: String(sessionId), deleted: await this.repo.delete(sessionId) };
  }

  // === internals ==========================================================

  /** @private Advance one direction's chain + persist. */
  async _advanceChain(sessionId, role, options) {
    if (!this.keyStore) throw new KeyStoreRequiredError("advancing a chain requires a device-local key store");
    const state = requireHierarchy(await this.repo.findBySessionId(this._id(sessionId)), sessionId);
    const advanced = role === ChainRole.SENDING ? this.keyStore.advanceSending(sessionId) : this.keyStore.advanceReceiving(sessionId);
    const chainField = role === ChainRole.SENDING ? "sendingChain" : "receivingChain";
    const nextMeta = advanceChainMeta(state[chainField], advanced.key, { at: this._iso(), reason: options.reason });
    // do not retain the raw key beyond metadata extraction
    disposeKeyRef(advanced);

    const at = this._iso();
    const updated = await this.repo.update(sessionId, {
      [chainField]: nextMeta,
      metadata: recomputeMetadata({ ...state, [chainField]: nextMeta }),
      audit: appendAudit(state.audit, auditEntry(AuditAction.CHAIN_ADVANCED, { at, generation: state.generation, chainId: nextMeta.chainId, direction: nextMeta.direction, role, index: nextMeta.index, fingerprint: nextMeta.fingerprint, reason: options.reason })),
      updatedAt: at,
    });
    this._emit(KeyHierarchyEventType.CHAIN_ADVANCED, { sessionId: String(sessionId), generation: state.generation, chainId: nextMeta.chainId, direction: nextMeta.direction, role, index: nextMeta.index, fingerprint: nextMeta.fingerprint });
    return toPublicHierarchy(updated);
  }

  /** @private Resolve a live chain key from the device store. */
  _resolveChainKey(sessionId, which) {
    if (!this.keyStore) throw new KeyStoreRequiredError(`resolving the ${which} chain key requires the device key store`);
    const chainKey = which === "sending" ? this.keyStore.getSendingKey(sessionId) : this.keyStore.getReceivingKey(sessionId);
    if (!chainKey) throw new KeyStoreRequiredError(`No ${which} chain key for this session`);
    const index = which === "sending" ? this.keyStore.sendingIndex(sessionId) : this.keyStore.receivingIndex(sessionId);
    return { chainKey, index, chainKeyId: null };
  }

  /** @private */
  _audit(audit, entries) {
    return entries.reduce((acc, e) => appendAudit(acc, e), audit ?? []);
  }

  /** @private */
  _emit(type, payload) {
    this.events.emit(type, payload);
  }

  /** @private */
  _id(sessionId) {
    return validateSessionRef(sessionId);
  }

  /** @private */
  _iso() {
    return new Date(this.clock()).toISOString();
  }
}

/** The advance result holds a reference to the live key (still owned by the store) — we do
 * NOT dispose it here (the store owns its lifecycle); only drop our local reference. */
function disposeKeyRef(advanced) {
  advanced.key = null; // drop our copy of the reference; the store retains the real buffer
}
