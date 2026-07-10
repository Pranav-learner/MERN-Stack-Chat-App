/**
 * @module forward-secrecy/manager
 *
 * The **Forward Secrecy Manager** — the reusable facade for the engine (Layer 5,
 * Sprint 2). It owns the cryptographic evolution of a session: seed the chain, evolve to
 * a fresh generation, activate the new keys, securely destroy the obsolete ones, keep the
 * metadata repository + audit trail in sync, and (optionally) advance the Sprint 1
 * Evolution Framework generation.
 *
 * ## Two modes (mirrors the Secure Session manager)
 * - **Device mode** (client / reference / tests) — constructed with a
 *   {@link ForwardSecrecyKeyStore}. `start` / `evolve` derive + destroy real key material;
 *   `resolveEncryptionKeys` / `resolveDecryptionKeys` feed the Secure Transport layer. Keys
 *   never leave the device.
 * - **Descriptor mode** (server) — constructed WITHOUT a key store. `recordEvolution`
 *   tracks the FS generation METADATA a device reported; read-only otherwise. The server
 *   never holds a chain secret or key.
 *
 * @security This IS a cryptographic component. Secrets live ONLY in the device key store;
 * the repository, DTOs, events, and audit records carry METADATA only. Every evolution
 * destroys the previous chain secret (one-way) — that is the forward-secrecy guarantee.
 *
 * @example Device
 * ```js
 * const fs = new ForwardSecrecyManager({ ...createInMemoryForwardSecrecyRepository(), keyStore: new ForwardSecrecyKeyStore() });
 * await fs.start({ sessionId, handshakeId, participants: ["alice","bob"], rootSecret });
 * await fs.evolve(sessionId, { reason: "rotation", trigger: "manual" });  // fresh keys; old ones destroyed
 * const keys = fs.resolveEncryptionKeys(sessionId); // current generation — for Secure Transport
 * ```
 */

import crypto from "node:crypto";
import {
  ForwardSecrecyEventType,
  GenerationStatus,
  DestructionReason,
  EvolutionTrigger,
  FS_KDF,
  FS_CIPHER_ALGORITHM,
  FS_CHAIN_VERSION,
  DEFAULT_RETAINED_GENERATIONS,
  FS_SCHEMA_VERSION,
  INITIAL_GENERATION,
} from "../types/types.js";
import {
  KeyStoreRequiredError,
  ForwardSecrecyStateError,
  EvolutionFailedError,
} from "../errors.js";
import { seedChain, evolveChain, deriveGenerationKeys } from "../derivation/keyChain.js";
import { destroyIntermediateMaterial } from "../destruction/secureDestruction.js";
import {
  validateSessionRef,
  requireState,
  validateEvolutionRequest,
  assertGenerationOrdering,
  assertSessionOwnership,
  assertSessionState,
  assertVersionConsistency,
  assertNotDestroyed,
  assertNoReplay,
  validateRepository,
} from "../validation/validators.js";
import { auditEntry, appendAudit, AuditAction } from "../audit/audit.js";
import { toPublicForwardSecrecy, toForwardSecrecyStatus, toPublicGeneration } from "../serialization/serializer.js";
import { ForwardSecrecyEventBus } from "../events/events.js";

export class ForwardSecrecyManager {
  /**
   * @param {object} deps
   * @param {object} deps.forwardSecrecy metadata repository (required)
   * @param {import("../keystore/forwardSecrecyKeyStore.js").ForwardSecrecyKeyStore} [deps.keyStore] device key store (device mode)
   * @param {ForwardSecrecyEventBus} [deps.events]
   * @param {object} [deps.evolution] a Sprint 1 EvolutionManager to keep generation metadata in sync
   * @param {(scope: string, error: Error) => void} [deps.onError]
   * @param {() => number} [deps.clock] @param {number} [deps.retainedGenerations]
   */
  constructor(deps) {
    if (!deps || !deps.forwardSecrecy) throw new Error("ForwardSecrecyManager requires { forwardSecrecy }");
    this.repo = validateRepository(deps.forwardSecrecy);
    this.keyStore = deps.keyStore ?? null;
    this.events = deps.events ?? new ForwardSecrecyEventBus();
    this.evolution = deps.evolution ?? null;
    this.clock = deps.clock ?? (() => Date.now());
    this.retainedGenerations = deps.retainedGenerations ?? DEFAULT_RETAINED_GENERATIONS;
    this._onError = deps.onError ?? ((scope, error) => console.error(`[forward-secrecy] ${scope}:`, error?.message));
  }

  // === startup =============================================================

  /**
   * Start forward secrecy for a session: seed the chain (generation 0), derive + activate
   * the first generation's keys, and persist the metadata. DEVICE mode.
   *
   * @param {object} params
   * @param {string} params.sessionId @param {string} [params.handshakeId]
   * @param {Buffer|Uint8Array} params.rootSecret the device-local Layer 4 shared secret
   * @param {string[]} [params.participants] @param {object} [params.deviceIds] @param {string} [params.protocolVersion]
   * @param {string} [params.actingUser] @param {string} [params.sessionStatus]
   * @returns {Promise<object>} the public FS DTO
   * @throws {KeyStoreRequiredError | ForwardSecrecyStateError}
   */
  async start(params) {
    if (!this.keyStore) throw new KeyStoreRequiredError("start requires a device-local forward-secrecy key store");
    validateSessionRef(params.sessionId);
    if (await this.repo.findBySessionId(params.sessionId)) {
      throw new ForwardSecrecyStateError("Forward secrecy is already started for this session", { details: { sessionId: params.sessionId } });
    }
    assertSessionOwnership(params.participants, params.actingUser);
    assertSessionState(params.sessionStatus);

    const sessionContext = {
      handshakeId: params.handshakeId ?? params.sessionId,
      participants: params.participants ?? [],
      deviceIds: params.deviceIds,
      protocolVersion: params.protocolVersion ?? "1.0",
    };
    const chainContext = { sessionId: String(params.sessionId), handshakeId: params.handshakeId };

    const chain0 = seedChain(params.rootSecret, chainContext);
    const keys0 = deriveGenerationKeys(chain0, sessionContext, INITIAL_GENERATION);
    this.keyStore.initialize(params.sessionId, chain0, keys0, { sessionContext, chainContext });

    const at = this._nowIso();
    const gen0 = this._generationRecord({ generation: 0, keys: keys0, status: GenerationStatus.ACTIVE, at, trigger: EvolutionTrigger.SYSTEM, reason: "forward-secrecy-started", activatedAt: at });
    const state = {
      sessionId: String(params.sessionId),
      handshakeId: params.handshakeId,
      owners: (params.participants ?? []).map(String),
      started: true,
      currentGeneration: INITIAL_GENERATION,
      generations: [gen0],
      destructions: [],
      audit: [auditEntry(AuditAction.STARTED, { at, generation: 0, keyId: keys0.keyId })],
      security: this._security(),
      createdAt: at,
      updatedAt: at,
      schemaVersion: FS_SCHEMA_VERSION,
    };
    await this.repo.create(state);

    this._emit(ForwardSecrecyEventType.FORWARD_SECRECY_STARTED, { sessionId: state.sessionId, generation: 0, keyId: keys0.keyId });
    this._emit(ForwardSecrecyEventType.GENERATION_CREATED, { sessionId: state.sessionId, generation: 0, keyId: keys0.keyId });
    this._emit(ForwardSecrecyEventType.GENERATION_ACTIVATED, { sessionId: state.sessionId, generation: 0, keyId: keys0.keyId });
    return toPublicForwardSecrecy(state);
  }

  // === evolution (the core operation) =====================================

  /**
   * Evolve the session to the next generation: derive `chainₙ₊₁` + fresh keys, activate
   * them, and securely destroy the previous chain secret (and generations aged out of the
   * retention window). DEVICE mode. This is what delivers forward secrecy.
   *
   * @param {string} sessionId
   * @param {{ reason?: string, trigger?: string, actingUser?: string, sessionStatus?: string }} [options]
   * @returns {Promise<object>} the public FS DTO (new generation active)
   * @throws {KeyStoreRequiredError | GenerationOrderingError | RollbackDetectedError | ReplayDetectedError | EvolutionFailedError}
   */
  async evolve(sessionId, options = {}) {
    if (!this.keyStore) throw new KeyStoreRequiredError("evolve requires a device-local forward-secrecy key store");
    validateEvolutionRequest({ sessionId, reason: options.reason, trigger: options.trigger });
    const state = requireState(await this.repo.findBySessionId(sessionId), sessionId);
    if (!state.started) throw new ForwardSecrecyStateError("Forward secrecy has not been started for this session", { details: { sessionId } });
    assertSessionOwnership(state.owners, options.actingUser);
    assertSessionState(options.sessionStatus);

    const current = state.currentGeneration;
    const next = current + 1;
    assertGenerationOrdering(current, next); // forward-only, +1 (rollback prevention)
    assertNoReplay(state.generations, next); // replay resistance
    assertVersionConsistency(this.keyStore.currentGeneration(sessionId), current); // store ↔ repo consistency

    const chain = assertNotDestroyed(this.keyStore.getChainSecret(sessionId), current); // destroyed-key guard
    const ctx = this.keyStore.getContext(sessionId);
    const trigger = options.trigger ?? EvolutionTrigger.MANUAL;
    const at = this._nowIso();

    // --- derive intermediate material (may fail) ---------------------------
    let nextChain, nextKeys;
    try {
      nextChain = evolveChain(chain, next, ctx.chainContext);
      nextKeys = deriveGenerationKeys(nextChain, ctx.sessionContext, next);
    } catch (error) {
      const destroyed = destroyIntermediateMaterial({ chainSecret: nextChain, keys: nextKeys, generation: next, at });
      await this._recordFailure(state, next, error, destroyed, at);
      throw new EvolutionFailedError("Failed to derive the next generation", { cause: error, details: { sessionId, generation: next } });
    }

    // --- commit + destroy previous secrets ---------------------------------
    let chainDestruction, pruneDestructions;
    try {
      chainDestruction = this.keyStore.commitEvolution(sessionId, nextChain, next, nextKeys, { at });
      pruneDestructions = this.keyStore.pruneOlderThan(sessionId, next - this.retainedGenerations, { at });
    } catch (error) {
      const destroyed = destroyIntermediateMaterial({ chainSecret: nextChain, keys: nextKeys, generation: next, at });
      await this._recordFailure(state, next, error, destroyed, at);
      throw new EvolutionFailedError("Failed to activate the next generation", { cause: error, details: { sessionId, generation: next } });
    }

    // --- update metadata ---------------------------------------------------
    const prunedGens = new Set(pruneDestructions.map((d) => d.generation));
    const generations = state.generations.map((g) => {
      // A pruned generation is DESTROYED — this wins even for the just-superseded current
      // generation (strict window `retainedGenerations: 0` destroys it immediately).
      if (prunedGens.has(g.generation)) {
        return { ...g, status: GenerationStatus.DESTROYED, destroyedAt: at };
      }
      if (g.generation === current && g.status === GenerationStatus.ACTIVE) {
        return { ...g, status: GenerationStatus.SUPERSEDED, supersededAt: at };
      }
      return g;
    });
    generations.push(this._generationRecord({ generation: next, keys: nextKeys, status: GenerationStatus.ACTIVE, at, trigger, reason: options.reason, activatedAt: at }));

    const destructions = [...state.destructions, chainDestruction, ...pruneDestructions];
    let audit = appendAudit(state.audit, auditEntry(AuditAction.GENERATION_CREATED, { at, generation: next, keyId: nextKeys.keyId, trigger, reason: options.reason }));
    audit = appendAudit(audit, auditEntry(AuditAction.GENERATION_ACTIVATED, { at, generation: next, keyId: nextKeys.keyId }));
    audit = appendAudit(audit, auditEntry(AuditAction.KEYS_DESTROYED, { at, generation: current, reason: DestructionReason.SUPERSEDED, details: { destroyed: destructions.length } }));
    audit = appendAudit(audit, auditEntry(AuditAction.EVOLUTION_COMPLETED, { at, generation: next, trigger, reason: options.reason }));

    const updated = await this.repo.update(sessionId, {
      currentGeneration: next,
      generations,
      destructions,
      audit,
      updatedAt: at,
    });

    // --- sync the Sprint 1 evolution generation (best-effort) --------------
    await this._syncEvolution(sessionId, options.reason, trigger);

    // --- events ------------------------------------------------------------
    this._emit(ForwardSecrecyEventType.GENERATION_ADVANCED, { sessionId: updated.sessionId, generation: next, previousGeneration: current, keyId: nextKeys.keyId, trigger, reason: options.reason });
    this._emit(ForwardSecrecyEventType.GENERATION_ACTIVATED, { sessionId: updated.sessionId, generation: next, keyId: nextKeys.keyId });
    this._emit(ForwardSecrecyEventType.KEYS_DESTROYED, { sessionId: updated.sessionId, generation: current, reason: DestructionReason.SUPERSEDED, details: { count: destructions.length - state.destructions.length } });
    this._emit(ForwardSecrecyEventType.EVOLUTION_COMPLETED, { sessionId: updated.sessionId, generation: next, previousGeneration: current, trigger, reason: options.reason });
    this._emit(ForwardSecrecyEventType.TRANSPORT_UPDATED, { sessionId: updated.sessionId, generation: next, keyId: nextKeys.keyId });
    return toPublicForwardSecrecy(updated);
  }

  // === descriptor mode (server) ===========================================

  /**
   * Record a device-reported evolution (DESCRIPTOR mode — server tracks metadata only, no
   * keys). Validates ordering + replay, then appends the generation record.
   * @param {string} sessionId
   * @param {{ generation: number, keyId?: string, fingerprint?: string, algorithm?: string, trigger?: string, reason?: string }} report
   * @returns {Promise<object>} the public FS DTO
   */
  async recordEvolution(sessionId, report) {
    validateSessionRef(sessionId);
    const state = requireState(await this.repo.findBySessionId(sessionId), sessionId);
    assertGenerationOrdering(state.currentGeneration, report.generation);
    assertNoReplay(state.generations, report.generation);
    const at = this._nowIso();
    const generations = state.generations.map((g) =>
      g.generation === state.currentGeneration && g.status === GenerationStatus.ACTIVE ? { ...g, status: GenerationStatus.SUPERSEDED, supersededAt: at } : g,
    );
    generations.push({
      generation: report.generation,
      keyId: report.keyId,
      fingerprint: report.fingerprint,
      algorithm: report.algorithm ?? FS_CIPHER_ALGORITHM,
      status: GenerationStatus.ACTIVE,
      createdAt: at,
      activatedAt: at,
      trigger: report.trigger,
      reason: report.reason,
    });
    const updated = await this.repo.update(sessionId, {
      currentGeneration: report.generation,
      generations,
      audit: appendAudit(state.audit, auditEntry(AuditAction.EVOLUTION_COMPLETED, { at, generation: report.generation, trigger: report.trigger, reason: report.reason })),
      updatedAt: at,
    });
    this._emit(ForwardSecrecyEventType.GENERATION_ADVANCED, { sessionId: updated.sessionId, generation: report.generation, keyId: report.keyId });
    return toPublicForwardSecrecy(updated);
  }

  /**
   * Register a device-started forward-secrecy session (DESCRIPTOR mode). Records the
   * generation-0 metadata a device reports; derives + holds no keys.
   * @param {object} descriptor { sessionId, handshakeId?, keyId?, fingerprint?, participants? }
   * @returns {Promise<object>} the public FS DTO
   */
  async register(descriptor) {
    validateSessionRef(descriptor.sessionId);
    if (await this.repo.findBySessionId(descriptor.sessionId)) {
      throw new ForwardSecrecyStateError("Forward secrecy is already tracked for this session", { details: { sessionId: descriptor.sessionId } });
    }
    const at = this._nowIso();
    const state = {
      sessionId: String(descriptor.sessionId),
      handshakeId: descriptor.handshakeId,
      owners: (descriptor.participants ?? []).map(String),
      started: true,
      currentGeneration: INITIAL_GENERATION,
      generations: [{ generation: 0, keyId: descriptor.keyId, fingerprint: descriptor.fingerprint, algorithm: FS_CIPHER_ALGORITHM, status: GenerationStatus.ACTIVE, createdAt: at, activatedAt: at, reason: "registered" }],
      destructions: [],
      audit: [auditEntry(AuditAction.STARTED, { at, generation: 0, keyId: descriptor.keyId })],
      security: this._security(),
      createdAt: at,
      updatedAt: at,
      schemaVersion: FS_SCHEMA_VERSION,
    };
    await this.repo.create(state);
    this._emit(ForwardSecrecyEventType.FORWARD_SECRECY_STARTED, { sessionId: state.sessionId, generation: 0, keyId: descriptor.keyId });
    return toPublicForwardSecrecy(state);
  }

  // === queries =============================================================

  /** The public FS state DTO for a session. @returns {Promise<object>} */
  async getState(sessionId) {
    validateSessionRef(sessionId);
    return toPublicForwardSecrecy(requireState(await this.repo.findBySessionId(sessionId), sessionId));
  }

  /** The public FS state DTO, or null if none exists. */
  async findState(sessionId) {
    validateSessionRef(sessionId);
    const state = await this.repo.findBySessionId(sessionId);
    return state ? toPublicForwardSecrecy(state) : null;
  }

  /** Compact status (current generation + active keyId). */
  async getStatus(sessionId) {
    validateSessionRef(sessionId);
    return toForwardSecrecyStatus(requireState(await this.repo.findBySessionId(sessionId), sessionId));
  }

  /** The generation metadata history. */
  async getHistory(sessionId) {
    validateSessionRef(sessionId);
    const state = requireState(await this.repo.findBySessionId(sessionId), sessionId);
    return (state.generations ?? []).map(toPublicGeneration);
  }

  /** The audit trail (metadata only). */
  async getAudit(sessionId) {
    validateSessionRef(sessionId);
    const state = requireState(await this.repo.findBySessionId(sessionId), sessionId);
    return (state.audit ?? []).map((a) => ({ ...a }));
  }

  // === transport key resolution (DEVICE mode) =============================

  /**
   * The CURRENT generation's device-local keys (for the Secure Transport encryptor).
   * NEVER exposed via any API. @param {string} sessionId @returns {object} SessionKeys
   * @throws {KeyStoreRequiredError}
   */
  resolveEncryptionKeys(sessionId) {
    if (!this.keyStore) throw new KeyStoreRequiredError("resolveEncryptionKeys requires the device key store");
    return assertNotDestroyed(this.keyStore.getCurrentKeys(sessionId), this.keyStore.currentGeneration(sessionId));
  }

  /**
   * The device-local keys for the generation that produced a given PUBLIC `keyId` (for
   * decrypting a received payload). Returns null if that generation's keys were destroyed.
   * @param {string} sessionId @param {{ keyId: string }} selector @returns {object|null}
   * @throws {KeyStoreRequiredError}
   */
  resolveDecryptionKeys(sessionId, selector) {
    if (!this.keyStore) throw new KeyStoreRequiredError("resolveDecryptionKeys requires the device key store");
    return this.keyStore.findKeysByKeyId(sessionId, selector?.keyId) ?? null;
  }

  // === teardown ============================================================

  /**
   * End forward secrecy for a session: securely destroy ALL key material and mark every
   * generation destroyed. Terminal.
   * @param {string} sessionId @param {{ reason?: string }} [options] @returns {Promise<object>}
   */
  async destroy(sessionId, options = {}) {
    validateSessionRef(sessionId);
    const state = requireState(await this.repo.findBySessionId(sessionId), sessionId);
    if (this.keyStore) this.keyStore.destroySession(sessionId);
    const at = this._nowIso();
    const generations = state.generations.map((g) => (g.status === GenerationStatus.DESTROYED ? g : { ...g, status: GenerationStatus.DESTROYED, destroyedAt: at }));
    const updated = await this.repo.update(sessionId, {
      started: false,
      generations,
      audit: appendAudit(state.audit, auditEntry(AuditAction.SESSION_ENDED, { at, reason: options.reason ?? DestructionReason.SESSION_ENDED })),
      updatedAt: at,
    });
    this._emit(ForwardSecrecyEventType.KEYS_DESTROYED, { sessionId: updated.sessionId, reason: options.reason ?? DestructionReason.SESSION_ENDED, details: { scope: "all-generations" } });
    return toPublicForwardSecrecy(updated);
  }

  /** Delete the FS metadata record entirely (housekeeping). */
  async deleteState(sessionId) {
    validateSessionRef(sessionId);
    if (this.keyStore) this.keyStore.destroySession(sessionId);
    return { sessionId: String(sessionId), deleted: await this.repo.delete(sessionId) };
  }

  // === internals ==========================================================

  /** @private Build a PUBLIC generation metadata record (reads public keyId/fingerprint). */
  _generationRecord({ generation, keys, status, at, trigger, reason, activatedAt }) {
    const record = {
      generation,
      keyId: keys.keyId,
      fingerprint: keys.keyFingerprint,
      algorithm: FS_CIPHER_ALGORITHM,
      status,
      createdAt: at,
    };
    if (activatedAt) record.activatedAt = activatedAt;
    if (trigger) record.trigger = trigger;
    if (reason) record.reason = reason;
    return record;
  }

  /** @private Persist a failed-evolution outcome (audit + destruction) and emit. */
  async _recordFailure(state, generation, error, destruction, at) {
    try {
      await this.repo.update(state.sessionId, {
        destructions: [...state.destructions, destruction],
        audit: appendAudit(state.audit, auditEntry(AuditAction.EVOLUTION_FAILED, { at, generation, reason: error?.code ?? "error" })),
        updatedAt: at,
      });
    } catch (e) {
      this._onError("recordFailure", e);
    }
    this._emit(ForwardSecrecyEventType.EVOLUTION_FAILED, { sessionId: state.sessionId, generation, reason: error?.code ?? "error" });
  }

  /** @private Best-effort sync of the Sprint 1 Evolution Framework generation. */
  async _syncEvolution(sessionId, reason, trigger) {
    if (!this.evolution) return;
    try {
      const existing = await this.evolution.findEvolutionState(sessionId);
      if (existing && !existing.isRetired) {
        await this.evolution.advanceGeneration(sessionId, { reason: reason ?? "forward-secrecy", trigger });
      }
    } catch (error) {
      this._onError("syncEvolution", error); // never undo a successful crypto evolution
    }
  }

  /** @private */
  _security() {
    return {
      forwardSecrecy: true,
      oneWayChain: true,
      kdf: FS_KDF,
      algorithm: FS_CIPHER_ALGORITHM,
      chainVersion: FS_CHAIN_VERSION,
      retainedGenerations: this.retainedGenerations,
      // Explicitly NOT implemented in this sprint:
      doubleRatchet: false,
      chainKeys: false,
      messageKeys: false,
      postCompromiseSecurity: false,
    };
  }

  /** @private */
  _emit(type, payload) {
    this.events.emit(type, payload);
  }

  /** @private */
  _nowIso() {
    return new Date(this.clock()).toISOString();
  }
}
