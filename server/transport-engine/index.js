/**
 * @module transport-engine
 *
 * **Layer 8 · Sprint 2 — Large Payload Transport & Transport Optimization.** Efficiently transports
 * LARGE, already-encrypted payloads (files, images, videos, voice notes, documents, binary) across the
 * Active Connections Layer 7 established, ON TOP of the Sprint 1 Reliable Messaging Engine. It
 * fragments a payload into chunks, schedules their transmission under a sliding window with
 * backpressure, multiplexes many concurrent transfers with fair priority scheduling, and reassembles +
 * integrity-validates the payload on the receiver.
 *
 * @security Carries **opaque ciphertext ONLY.** A payload arrives ALREADY ENCRYPTED; the engine slices
 * the ciphertext, never decrypts it, and stores no plaintext or key material. Checksums are integrity
 * hashes over ciphertext.
 *
 * @evolution Transport-INDEPENDENT (injected transport → reuses WebRTC / QUIC / TCP / relay). Does NOT
 * implement voice calls, video calls, live streaming, or media codecs — Layer 11. The `stream` seam is
 * inert.
 *
 * @example
 * ```js
 * import { createTransportEngineService, createLoopbackNetwork, createInMemoryTransportRepository } from "./transport-engine/index.js";
 * const net = createLoopbackNetwork();
 * const alice = createTransportEngineService({ deviceId: "alice", transport: net.transport, repository: createInMemoryTransportRepository() });
 * const bob = createTransportEngineService({ deviceId: "bob", transport: net.transport, repository: createInMemoryTransportRepository() });
 * net.routes.set("alice", alice.engine); net.routes.set("bob", bob.engine);
 * bob.onPayload(({ payload, payloadMeta }) => save(decrypt(payload), payloadMeta));
 * await alice.startTransfer({ conversationId: "c1", receiverDeviceId: "bob", payload: ciphertext, payloadMeta: { kind: "image" } });
 * await net.flush(); // run the transfer to completion
 * ```
 */

// Types + errors
export * from "./types/types.js";
export * from "./errors.js";

// Lifecycle FSMs
export {
  ALLOWED_TRANSFER_TRANSITIONS,
  ALLOWED_CHUNK_TRANSITIONS,
  canTransferTransition,
  assertTransferTransition,
  canChunkTransition,
  assertChunkTransition,
  nextTransferStates,
  TransferLifecycle,
} from "./lifecycle/lifecycle.js";

// Chunk model + fragmentation + reassembly
export { createChunk, verifyChunk, checksumOf, chunkIdFor, toBuffer } from "./chunks/chunk.js";
export { fragmentPayload, clampChunkSize, chunkCountFor } from "./fragmentation/fragmenter.js";
export { Reassembler } from "./reassembly/reassembler.js";

// Flow control, backpressure, priorities, multiplexing, scheduling
export { FlowController } from "./flow-control/flowController.js";
export { ReceiverBackpressure, SenderResourceGuard } from "./buffering/backpressure.js";
export { priorityWeight, effectiveWeight, compareCandidates, isStarving } from "./priorities/priority.js";
export { Multiplexer } from "./multiplexing/multiplexer.js";
export { TransferScheduler, TransportPumpScheduler } from "./scheduler/scheduler.js";

// Wire + transport contract
export { buildChunkEnvelope, buildChunkAckEnvelope, buildControlEnvelope, isTransportEnvelope, createLoopbackNetwork } from "./transport/wire.js";

// Validators, serializers, events
export * from "./validators/validators.js";
export { toPublicTransfer, toProgress, toChunkStatus, toTransferListItem } from "./serializers/serializer.js";
export { TransportEventBus } from "./events/events.js";

// Repositories
export { createInMemoryTransportRepository } from "./repository/inMemoryTransportRepository.js";
export { createMongoTransportRepository } from "./repository/mongoTransportRepository.js";

// Engine + facades
export { TransportEngine } from "./manager/transportEngine.js";
export { TransportEngineService, createTransportEngineService } from "./api/transportApi.js";
export { TransportRelayService, createTransportRelayService } from "./api/relayService.js";
