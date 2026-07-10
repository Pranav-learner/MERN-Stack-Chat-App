/**
 * @module message-keys/manager
 *
 * The **Message Key Manager** — the reusable facade for per-message key management (Layer 5,
 * Sprint 5). It derives a unique key for each message from the active sending/receiving chain
 * (Sprint 4 {@link ChainManager}), drives the single encrypt/decrypt, **destroys the key
 * immediately**, then advances the chain. Out-of-order receipt is handled with a bounded
 * skipped-key cache.
 *
 * ## Flows (Steps 6–7)
 * ```
 * send:    resolve sending chain ─▶ derive MKₙ ─▶ encrypt ─▶ DESTROY MKₙ ─▶ advance sending chain
 * receive: resolve receiving chain ─▶ derive MKₙ (skip-cache gaps) ─▶ decrypt ─▶ DESTROY MKₙ ─▶ advance receiving chain
 * ```
 *
 * @security Message keys are EPHEMERAL: they exist only inside {@link sealMessage} /
 * {@link openMessage}, are wiped before those return (even on failure), and are never
 * persisted, serialized, logged, or returned. The repository records METADATA only.
 *
 * @important DEVICE mode only — requires a {@link ChainManager} with a device key store.
 *
 * @example
 * ```js
 * const mk = new MessageKeyManager({ ...createInMemoryMessageKeyRepository(), chainManager, cache: new MessageKeyCache() });
 * const { result: envelope } = await mk.sealMessage(sessionId, (keys, meta) => encrypt(msg, keys, meta));
 * const { result: plaintext } = await mk.openMessage(sessionId, { messageNumber, generation }, (keys) => decrypt(payload, keys));
 * ```
 */

import crypto from "node:crypto";
import {
  MessageKeyEventType,
  MessageDirection,
  DeliveryStatus,
  DEFAULT_MAX_SKIP,
  MK_SCHEMA_VERSION,
} from "../types/types.js";
import { KeyStoreRequiredError, ChainResolutionError, TooManySkippedError, GenerationMismatchError } from "../errors.js";
import { deriveMessageKey } from "../derivation/derivation.js";
import { destroyMessageKey } from "../destruction/destruction.js";
import { MessageKeyCache } from "../cache/messageKeyCache.js";
import { createMessageMeta, createSecurityMetadata, recomputeMetadata } from "../metadata/metadata.js";
import { auditEntry, appendAudit, AuditAction } from "../audit/audit.js";
import {
  validateSessionRef,
  requireState,
  validateMessageNumber,
  validateGeneration,
  assertGenerationMatch,
  assertNotConsumed,
  validateRepository,
} from "../validators/validators.js";
import { MessageKeyEventBus } from "../events/events.js";
import { toPublicMessageKeyState, toMessageKeyStatus, toPublicMessageMeta } from "../serialization/serializer.js";

const MESSAGE_LOG_CAP = 500;

export class MessageKeyManager {
  /**
   * @param {object} deps
   * @param {object} deps.messageKeys repository (required)
   * @param {import("../../key-hierarchy/manager/chainManager.js").ChainManager} deps.chainManager (device mode, required)
   * @param {MessageKeyCache} [deps.cache] @param {MessageKeyEventBus} [deps.events]
   * @param {() => number} [deps.clock] @param {number} [deps.maxSkip]
   * @param {(scope: string, error: Error) => void} [deps.onError]
   */
  constructor(deps) {
    if (!deps || !deps.messageKeys) throw new Error("MessageKeyManager requires { messageKeys }");
    if (!deps.chainManager) throw new Error("MessageKeyManager requires { chainManager }");
    this.repo = validateRepository(deps.messageKeys);
    this.chains = deps.chainManager;
    this.events = deps.events ?? new MessageKeyEventBus();
    this.clock = deps.clock ?? (() => Date.now());
    this.maxSkip = deps.maxSkip ?? DEFAULT_MAX_SKIP;
    this._onError = deps.onError ?? ((scope, error) => console.error(`[message-keys] ${scope}:`, error?.message));
    this.cache = deps.cache ?? new MessageKeyCache({ clock: this.clock });
    /** @type {Map<string, Promise<any>>} per-(session,direction) mutex tails */
    this._locks = new Map();
  }

  // === send ================================================================

  /**
   * Seal one message: derive the sending message key, run `sealFn`, destroy the key, then
   * advance the sending chain. Serialized per session so concurrent sends never collide on a
   * message number. The key never leaves this method.
   * @param {string} sessionId
   * @param {(keys: import("../types/types.js").MessageKeyBundle, meta: { messageNumber: number, generation: number }) => any} sealFn
   * @returns {Promise<{ result: any, messageNumber: number, generation: number }>}
   */
  async sealMessage(sessionId, sealFn) {
    return this._withLock(`send:${sessionId}`, () => this._sealMessage(sessionId, sealFn));
  }

  /** @private */
  async _sealMessage(sessionId, sealFn) {
    validateSessionRef(sessionId);
    const ctx = await this._chainContext(sessionId, MessageDirection.SENDING);
    const resolved = this._resolveSending(sessionId);
    const messageNumber = resolved.index;

    const bundle = deriveMessageKey(resolved.chainKey, {
      direction: ctx.direction,
      generation: ctx.generation,
      messageNumber,
      context: { sessionId, handshakeId: ctx.handshakeId },
    });
    this._emit(MessageKeyEventType.MESSAGE_KEY_DERIVED, { sessionId, direction: MessageDirection.SENDING, generation: ctx.generation, messageNumber, keyId: bundle.keyId });

    let result;
    try {
      result = await sealFn(bundle, { messageNumber, generation: ctx.generation });
    } catch (error) {
      destroyMessageKey(bundle, { reason: "seal-failed" });
      await this._recordFailure(sessionId, MessageDirection.SENDING, messageNumber, ctx.generation, error);
      throw error;
    }
    const destruction = destroyMessageKey(bundle, { reason: "used", at: this._iso() });
    this._emit(MessageKeyEventType.MESSAGE_KEY_DESTROYED, { sessionId, direction: MessageDirection.SENDING, messageNumber, keyId: destruction.keyId, reason: "used" });

    await this.chains.advanceSendingChain(sessionId, { reason: "message-sent" });
    this._emit(MessageKeyEventType.CHAIN_ADVANCED, { sessionId, direction: MessageDirection.SENDING, generation: ctx.generation, messageNumber });

    await this._recordMessage(sessionId, {
      direction: MessageDirection.SENDING,
      generation: ctx.generation,
      messageNumber,
      keyId: destruction.keyId,
      fingerprint: destruction.fingerprint,
      delivery: DeliveryStatus.ENCRYPTED,
    });
    this._emit(MessageKeyEventType.MESSAGE_ENCRYPTED, { sessionId, direction: MessageDirection.SENDING, generation: ctx.generation, messageNumber, keyId: destruction.keyId });
    return { result, messageNumber, generation: ctx.generation };
  }

  // === receive =============================================================

  /**
   * Open one message: derive (or take from cache) the receiving message key for
   * `messageNumber`, run `openFn`, then destroy the key. Handles out-of-order receipt by
   * skip-deriving + caching the intervening keys.
   * @param {string} sessionId @param {{ messageNumber: number, generation: number }} envelope
   * @param {(keys: import("../types/types.js").MessageKeyBundle) => any} openFn
   * @returns {Promise<{ result: any, messageNumber: number, generation: number }>}
   */
  async openMessage(sessionId, envelope, openFn) {
    return this._withLock(`recv:${sessionId}`, () => this._openMessage(sessionId, envelope, openFn));
  }

  /** @private */
  async _openMessage(sessionId, envelope, openFn) {
    validateSessionRef(sessionId);
    const messageNumber = validateMessageNumber(envelope.messageNumber);
    const generation = validateGeneration(envelope.generation);
    const ctx = await this._chainContext(sessionId, MessageDirection.RECEIVING);
    assertGenerationMatch(generation, ctx.generation);

    const { bundle, fromCache } = await this._deriveReceiving(sessionId, ctx, messageNumber);
    this._emit(MessageKeyEventType.MESSAGE_KEY_DERIVED, { sessionId, direction: MessageDirection.RECEIVING, generation, messageNumber, keyId: bundle.keyId, details: { fromCache } });

    let result;
    try {
      result = await openFn(bundle);
    } catch (error) {
      destroyMessageKey(bundle, { reason: "open-failed" });
      await this._recordFailure(sessionId, MessageDirection.RECEIVING, messageNumber, generation, error);
      throw error;
    }
    const destruction = destroyMessageKey(bundle, { reason: "used", at: this._iso() });
    this._emit(MessageKeyEventType.MESSAGE_KEY_DESTROYED, { sessionId, direction: MessageDirection.RECEIVING, messageNumber, keyId: destruction.keyId, reason: "used" });

    await this._recordMessage(sessionId, {
      direction: MessageDirection.RECEIVING,
      generation,
      messageNumber,
      keyId: destruction.keyId,
      fingerprint: destruction.fingerprint,
      delivery: DeliveryStatus.DECRYPTED,
      updateReceiving: true,
    });
    this._emit(MessageKeyEventType.MESSAGE_DECRYPTED, { sessionId, direction: MessageDirection.RECEIVING, generation, messageNumber, keyId: destruction.keyId });
    return { result, messageNumber, generation };
  }

  // === configuration + queries ============================================

  /** Ensure a message-key metadata record exists for a session (idempotent). */
  async ensure(sessionId, options = {}) {
    validateSessionRef(sessionId);
    const existing = await this.repo.findBySessionId(sessionId);
    if (existing) return toPublicMessageKeyState(existing);
    const at = this._iso();
    const state = await this.chains.findState(sessionId).catch(() => null);
    const record = {
      sessionId: String(sessionId),
      handshakeId: options.handshakeId ?? state?.handshakeId,
      generation: state?.generation ?? 0,
      sending: { count: 0, lastNumber: -1 },
      receiving: { count: 0, lastNumber: -1, highestNumber: -1 },
      messages: [],
      audit: [],
      security: createSecurityMetadata(),
      createdAt: at,
      updatedAt: at,
      schemaVersion: MK_SCHEMA_VERSION,
    };
    record.metadata = recomputeMetadata(record);
    await this.repo.create(record);
    return toPublicMessageKeyState(record);
  }

  /** Full message-key state DTO. */
  async getState(sessionId) {
    return toPublicMessageKeyState(requireState(await this.repo.findBySessionId(this._id(sessionId)), sessionId), { includeMessages: true });
  }

  /** The DTO, or null. */
  async findState(sessionId) {
    validateSessionRef(sessionId);
    const state = await this.repo.findBySessionId(sessionId);
    return state ? toPublicMessageKeyState(state) : null;
  }

  /** Compact status (counts + last numbers). */
  async getStatus(sessionId) {
    return toMessageKeyStatus(requireState(await this.repo.findBySessionId(this._id(sessionId)), sessionId));
  }

  /** Recent message metadata. */
  async getMessages(sessionId) {
    return (requireState(await this.repo.findBySessionId(this._id(sessionId)), sessionId).messages ?? []).map(toPublicMessageMeta);
  }

  /** Audit trail. */
  async getAudit(sessionId) {
    return (requireState(await this.repo.findBySessionId(this._id(sessionId)), sessionId).audit ?? []).map((a) => ({ ...a }));
  }

  /** Prune expired cached skipped keys. */
  pruneCache() {
    const records = this.cache.pruneExpired(this.clock());
    for (const r of records) this._emit(MessageKeyEventType.MESSAGE_KEY_EXPIRED, { sessionId: undefined, keyId: r.keyId, reason: "expired" });
    return { expired: records.length };
  }

  /** Teardown: destroy cached keys + delete the metadata record. */
  async destroy(sessionId) {
    validateSessionRef(sessionId);
    this.cache.destroySession(sessionId);
    return { sessionId: String(sessionId), deleted: await this.repo.delete(sessionId) };
  }

  // === internals ==========================================================

  /** @private Read chain metadata for a direction (generation + canonical direction). */
  async _chainContext(sessionId, role) {
    if (!this.chains.keyStore) throw new KeyStoreRequiredError("message keys require a device-local chain key store");
    const state = await this.chains.findState(sessionId);
    if (!state) throw new ChainResolutionError("No key hierarchy for this session", { details: { sessionId } });
    const chain = role === MessageDirection.SENDING ? state.sendingChain : state.receivingChain;
    return { generation: state.generation, direction: chain.direction, handshakeId: state.handshakeId };
  }

  /** @private Resolve the live sending chain key + index. */
  _resolveSending(sessionId) {
    const resolved = this.chains.resolveSendingChainKey(sessionId);
    if (!resolved?.chainKey) throw new ChainResolutionError("No sending chain key", { details: { sessionId } });
    return resolved;
  }

  /**
   * @private Derive the receiving message key for `messageNumber`, skip-caching gaps and
   * serving already-skipped keys from the cache. Advances the receiving chain as needed.
   * Chain advances MUST be awaited: `advanceReceivingChain` awaits a repo read before it
   * mutates the key store, so firing it without awaiting would leave `resolveReceivingChainKey`
   * reading a stale index and deriving the wrong key.
   */
  async _deriveReceiving(sessionId, ctx, messageNumber) {
    const resolved = this.chains.resolveReceivingChainKey(sessionId);
    if (!resolved?.chainKey) throw new ChainResolutionError("No receiving chain key", { details: { sessionId } });
    const r = resolved.index;
    const derive = (chainKey, n) =>
      deriveMessageKey(chainKey, { direction: ctx.direction, generation: ctx.generation, messageNumber: n, context: { sessionId, handshakeId: ctx.handshakeId } });

    if (messageNumber < r) {
      // a past message: it must be a cached skipped key, else it was already consumed (replay).
      const cached = assertNotConsumed(this.cache.take(sessionId, ctx.direction, ctx.generation, messageNumber), messageNumber);
      return { bundle: cached, fromCache: true };
    }
    if (messageNumber - r > this.maxSkip) {
      throw new TooManySkippedError(`Refusing to skip ${messageNumber - r} messages (max ${this.maxSkip})`, { details: { current: r, target: messageNumber } });
    }
    // skip-derive + cache [r, messageNumber): derive MKᵢ from CKᵢ, cache it, THEN advance.
    for (let i = r; i < messageNumber; i++) {
      const skipped = derive(this.chains.resolveReceivingChainKey(sessionId).chainKey, i);
      this.cache.put(sessionId, ctx.direction, ctx.generation, i, skipped);
      this._emit(MessageKeyEventType.MESSAGE_KEY_CACHED, { sessionId, direction: MessageDirection.RECEIVING, generation: ctx.generation, messageNumber: i, keyId: skipped.keyId });
      await this.chains.advanceReceivingChain(sessionId, { reason: "skip" });
    }
    // derive the target at its index, then advance past it
    const bundle = derive(this.chains.resolveReceivingChainKey(sessionId).chainKey, messageNumber);
    await this.chains.advanceReceivingChain(sessionId, { reason: "message-received" });
    return { bundle, fromCache: false };
  }

  /** @private Persist message metadata + counters + audit. */
  async _recordMessage(sessionId, m) {
    const state = await this.repo.findBySessionId(sessionId);
    if (!state) return this._onError("recordMessage", new Error(`no state for ${sessionId}`));
    const meta = createMessageMeta({ sessionId, ...m, at: this._iso() });
    const messages = capMessages([...(state.messages ?? []), meta]);
    const patch = { messages, updatedAt: this._iso() };
    if (m.direction === MessageDirection.SENDING) {
      patch.sending = { count: (state.sending?.count ?? 0) + 1, lastNumber: m.messageNumber };
    } else {
      patch.receiving = {
        count: (state.receiving?.count ?? 0) + 1,
        lastNumber: m.messageNumber,
        highestNumber: Math.max(state.receiving?.highestNumber ?? -1, m.messageNumber),
      };
    }
    const merged = { ...state, ...patch };
    patch.metadata = recomputeMetadata(merged);
    patch.audit = appendAudit(state.audit, auditEntry(m.direction === MessageDirection.SENDING ? AuditAction.ENCRYPTED : AuditAction.DECRYPTED, { at: this._iso(), direction: m.direction, generation: m.generation, messageNumber: m.messageNumber, keyId: m.keyId }));
    await this.repo.update(sessionId, patch);
  }

  /** @private Record a derivation/use failure. */
  async _recordFailure(sessionId, direction, messageNumber, generation, error) {
    try {
      const state = await this.repo.findBySessionId(sessionId);
      if (!state) return;
      await this.repo.update(sessionId, {
        audit: appendAudit(state.audit, auditEntry(AuditAction.DERIVATION_FAILED, { at: this._iso(), direction, generation, messageNumber, reason: error?.code ?? "error" })),
        updatedAt: this._iso(),
      });
    } catch (e) {
      this._onError("recordFailure", e);
    }
    this._emit(MessageKeyEventType.DERIVATION_FAILED, { sessionId, direction, generation, messageNumber, reason: error?.code ?? "error" });
  }

  /** @private A promise-chain mutex serializing operations for a lock key. */
  _withLock(lockKey, fn) {
    const prev = this._locks.get(lockKey) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => this._locks.get(lockKey) === tail && this._locks.delete(lockKey),
      () => this._locks.get(lockKey) === tail && this._locks.delete(lockKey),
    );
    this._locks.set(lockKey, tail);
    return run;
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

/** Cap the message metadata log. */
function capMessages(messages) {
  return messages.length > MESSAGE_LOG_CAP ? messages.slice(messages.length - MESSAGE_LOG_CAP) : messages;
}

/** Re-export a stable id generator for callers that want one. */
export const newMessageId = () => crypto.randomUUID();
