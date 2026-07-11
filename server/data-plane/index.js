/**
 * @module data-plane
 *
 * **Layer 8 · Sprint 1 — Reliable P2P Messaging Engine.** The DATA PLANE: it transports ALREADY-
 * ENCRYPTED application messages across the Active Connections Layer 7 established, with guaranteed-
 * delivery semantics — reliable delivery, per-conversation ordering, ACKs, retransmission with
 * backoff, and duplicate detection.
 *
 * @security The data plane carries **opaque ciphertext ONLY**. It NEVER encrypts, decrypts, or
 * inspects a payload; the crypto layer (Layers 2–5) already produced the ciphertext. No record, wire
 * envelope, ACK, event, or DTO contains plaintext or key material (enforced by
 * {@link module:data-plane/validators}).
 *
 * @evolution Transport-INDEPENDENT: the engine sends over an INJECTED transport, so it reuses any
 * Layer-7 connection (WebRTC / QUIC / relay / TCP). It does NOT implement file transfer, chunking,
 * fragmentation, streaming, or media — the `fragment` slot on a message is the inert seam Sprint 2
 * fills.
 *
 * @example
 * ```js
 * import { createDataPlaneService, createLoopbackTransport, createInMemoryMessageRepository } from "./data-plane/index.js";
 *
 * // Wire two devices together (loopback stands in for a Layer-7 connection).
 * const registry = new Map();
 * const transport = createLoopbackTransport({ route: (id) => registry.get(id)?.engine });
 * const alice = createDataPlaneService({ deviceId: "alice", transport, repository: createInMemoryMessageRepository() });
 * const bob = createDataPlaneService({ deviceId: "bob", transport, repository: createInMemoryMessageRepository() });
 * registry.set("alice", alice); registry.set("bob", bob);
 *
 * bob.onMessage(({ encryptedPayload }) => decryptAndShow(encryptedPayload));
 * await alice.send({ conversationId: "c1", receiverDeviceId: "bob", encryptedPayload: ciphertext });
 * ```
 */

// Types + constants
export * from "./types/types.js";
export * from "./errors.js";

// Lifecycle FSM
export {
  ALLOWED_DELIVERY_TRANSITIONS,
  canDeliveryTransition,
  assertDeliveryTransition,
  nextDeliveryStates,
  DeliveryLifecycle,
} from "./lifecycle/lifecycle.js";

// Message model + helpers
export { createMessage, isMessageExpired, messageDedupeKey } from "./delivery/message.js";
export { DuplicateCache } from "./delivery/dedupe.js";

// Wire + transport contract
export { buildDataEnvelope, buildAckEnvelope, isWireEnvelope, createLoopbackTransport } from "./transport/wire.js";

// Ordering, ACK, retransmission, queue
export { OrderingEngine } from "./ordering/ordering.js";
export { newAckId, buildAck, validateAckBlock, DelayedAckBatcher } from "./acknowledgement/ack.js";
export {
  resolveRetryPolicy,
  computeBackoff,
  nextRetryAt,
  shouldRetry,
  RetransmissionScheduler,
} from "./retransmission/retransmission.js";
export { MessageQueue } from "./queue/messageQueue.js";

// Validators + serializers + events
export * from "./validators/validators.js";
export { toPublicMessage, toDeliveryStatus, toMessageListItem } from "./serializers/serializer.js";
export { MessagingEventBus } from "./events/events.js";

// Repositories
export { createInMemoryMessageRepository } from "./repository/inMemoryMessageRepository.js";
export { createMongoMessageRepository } from "./repository/mongoMessageRepository.js";

// Engine + service facade
export { MessagingEngine } from "./manager/messagingEngine.js";
export { DataPlaneService, createDataPlaneService } from "./api/messagingApi.js";
export { DataPlaneRelayService, createDataPlaneRelayService } from "./api/relayService.js";
