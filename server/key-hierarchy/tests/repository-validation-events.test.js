import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryKeyHierarchyRepository } from "../repository/inMemoryKeyHierarchyRepository.js";
import { KeyHierarchyEventBus } from "../events/events.js";
import { KeyHierarchyEventType, ChainDirection, ChainRole } from "../types/types.js";
import {
  validateSessionRef,
  requireHierarchy,
  assertValidRootKey,
  requireChain,
  assertChainMatch,
  assertChainForward,
  assertNoDuplicateChain,
  validateHierarchyMetadata,
  validateRepository,
} from "../validators/validators.js";
import { createRootKeyMeta } from "../root/rootKey.js";
import { createChainMeta, advanceChainMeta, archiveChainMeta } from "../chains/chain.js";
import { toPublicHierarchy, toHierarchyStatus } from "../serialization/serializer.js";
import {
  KeyHierarchyValidationError,
  HierarchyNotFoundError,
  InvalidRootKeyError,
  ChainMismatchError,
  ChainRollbackError,
  MissingChainError,
  DuplicateChainError,
  CorruptedHierarchyError,
} from "../errors.js";
import { deriveRootKey, deriveChainKey, advanceChainKey } from "../derivation/derivation.js";
import { makeSecret } from "./helpers.js";

const ctx = { sessionId: "session-000001", handshakeId: "hs", generation: 0 };
function sampleState() {
  const root = deriveRootKey(makeSecret(1), ctx);
  const send = deriveChainKey(root, ChainDirection.I2R, ctx);
  const recv = deriveChainKey(root, ChainDirection.R2I, ctx);
  return {
    sessionId: "session-000001",
    generation: 0,
    rootKey: createRootKeyMeta(root, { generation: 0 }),
    sendingChain: createChainMeta(send, { direction: ChainDirection.I2R, role: ChainRole.SENDING, generation: 0 }),
    receivingChain: createChainMeta(recv, { direction: ChainDirection.R2I, role: ChainRole.RECEIVING, generation: 0 }),
    archivedChains: [],
  };
}

describe("repository — in-memory contract", () => {
  let repo, reset;
  beforeEach(() => {
    ({ hierarchies: repo, reset } = createInMemoryKeyHierarchyRepository());
  });

  it("create/find/update/delete round-trips + deep-copies", async () => {
    await repo.create(sampleState());
    const got = await repo.findBySessionId("session-000001");
    got.generation = 99;
    assert.equal((await repo.findBySessionId("session-000001")).generation, 0, "store not mutated");
    await repo.update("session-000001", { generation: 1 });
    assert.equal((await repo.findBySessionId("session-000001")).generation, 1);
    assert.equal((await repo.findByGeneration(1)).length, 1);
    assert.equal(await repo.delete("session-000001"), true);
    await assert.rejects(() => repo.update("session-000009", {}), HierarchyNotFoundError);
    reset();
    assert.equal((await repo.listAll()).length, 0);
  });
});

describe("chain + root pure helpers", () => {
  it("advanceChainMeta increments index + records history; rollback impossible", () => {
    const root = deriveRootKey(makeSecret(2), ctx);
    let ck = deriveChainKey(root, ChainDirection.I2R, ctx);
    let meta = createChainMeta(ck, { direction: ChainDirection.I2R, role: ChainRole.SENDING, generation: 0 });
    const ck1 = advanceChainKey(ck, ctx, 1);
    meta = advanceChainMeta(meta, ck1);
    assert.equal(meta.index, 1);
    assert.equal(meta.history.length, 2);
    const archived = archiveChainMeta(meta);
    assert.equal(archived.status, "archived");
  });
});

describe("validators", () => {
  it("session ref, require, root key, chain guards", () => {
    assert.equal(validateSessionRef("session-000001"), "session-000001");
    assert.throws(() => validateSessionRef("x"), KeyHierarchyValidationError);
    assert.throws(() => requireHierarchy(null, "s"), HierarchyNotFoundError);
    assert.throws(() => assertValidRootKey(Buffer.alloc(16)), InvalidRootKeyError);
    assert.doesNotThrow(() => assertValidRootKey(Buffer.alloc(32)));
    assert.throws(() => requireChain(null, "sending"), MissingChainError);
  });

  it("chain match / forward / duplicate", () => {
    const s = sampleState();
    assert.doesNotThrow(() => assertChainMatch(s.sendingChain, { direction: ChainDirection.I2R, role: ChainRole.SENDING }));
    assert.throws(() => assertChainMatch(s.sendingChain, { direction: ChainDirection.R2I }), ChainMismatchError);
    assert.throws(() => assertChainForward(3, 3), ChainRollbackError);
    assert.doesNotThrow(() => assertChainForward(3, 4));
    assert.throws(() => assertNoDuplicateChain(s.sendingChain, s.sendingChain), DuplicateChainError);
  });

  it("metadata corruption + no-key-material invariant", () => {
    assert.doesNotThrow(() => validateHierarchyMetadata(sampleState()));
    assert.throws(() => validateHierarchyMetadata({}), CorruptedHierarchyError);
    assert.throws(() => validateHierarchyMetadata({ ...sampleState(), sharedSecret: "x" }), CorruptedHierarchyError);
    const bad = sampleState();
    bad.sendingChain = { ...bad.sendingChain, status: "bogus" };
    assert.throws(() => validateHierarchyMetadata(bad), CorruptedHierarchyError);
    assert.throws(() => validateRepository({}), KeyHierarchyValidationError);
  });
});

describe("serializer + event bus", () => {
  it("public DTO whitelists metadata; strips secrets", () => {
    const dto = toPublicHierarchy(sampleState());
    assert.ok(dto.rootKey.rootKeyId);
    assert.equal(dto.sendingChain.index, 0);
    assert.equal("audit" in dto, false);
    assert.equal(toHierarchyStatus(sampleState()).established, true);
  });

  it("event bus delivers to specific + wildcard, unsubscribes", () => {
    const bus = new KeyHierarchyEventBus();
    const seen = [];
    const all = [];
    const off = bus.on(KeyHierarchyEventType.CHAIN_ADVANCED, (e) => seen.push(e));
    bus.on("*", (e) => all.push(e));
    bus.emit(KeyHierarchyEventType.CHAIN_ADVANCED, { sessionId: "s", index: 1 });
    assert.equal(seen.length, 1);
    assert.equal(all.length, 1);
    off();
    bus.emit(KeyHierarchyEventType.CHAIN_ADVANCED, { sessionId: "s", index: 2 });
    assert.equal(seen.length, 1);
    assert.equal(all.length, 2);
  });
});
