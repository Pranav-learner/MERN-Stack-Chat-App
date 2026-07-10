/**
 * Test helpers for the Per-Message Key subsystem. Node built-ins only. Imports Sprint 2/4 via
 * SPECIFIC files (not index barrels) so the Mongo models / mongoose are never loaded. Not a
 * test file.
 */

import crypto from "node:crypto";
import { MessageKeyManager } from "../manager/messageKeyManager.js";
import { MessageKeyCache } from "../cache/messageKeyCache.js";
import { createInMemoryMessageKeyRepository } from "../repository/inMemoryMessageKeyRepository.js";
import { MessageKeyEventBus } from "../events/events.js";
import { createMessageKeyTransport } from "../transport/transportIntegration.js";
// Sprint 4 key hierarchy (device)
import { ChainManager } from "../../key-hierarchy/manager/chainManager.js";
import { KeyHierarchyKeyStore } from "../../key-hierarchy/keystore/keyHierarchyKeyStore.js";
import { createInMemoryKeyHierarchyRepository } from "../../key-hierarchy/repository/inMemoryKeyHierarchyRepository.js";
// Sprint 2 forward secrecy (device) — seeds the hierarchy's ratchetMaterial
import { ForwardSecrecyManager } from "../../forward-secrecy/manager/forwardSecrecyManager.js";
import { ForwardSecrecyKeyStore } from "../../forward-secrecy/keystore/forwardSecrecyKeyStore.js";
import { createInMemoryForwardSecrecyRepository } from "../../forward-secrecy/repository/inMemoryForwardSecrecyRepository.js";

export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  return clock;
}

export function makeSessionId(seed = 1) {
  return `session-${String(seed).padStart(6, "0")}`;
}

export function makeSecret(seed = 1) {
  return crypto.createHash("sha256").update(`mk-root-${seed}`).digest();
}

/**
 * Build a full device stack for ONE peer: forward secrecy → key hierarchy → message keys.
 * @param {{ role?: string, sessionId?: string, secret?: Buffer, maxSkip?: number }} [options]
 */
export async function makePeer(options = {}) {
  const clock = makeClock();
  const sessionId = options.sessionId ?? makeSessionId(1);
  const secret = options.secret ?? makeSecret(1);
  const handshakeId = "hs-000001";

  const fs = new ForwardSecrecyManager({ ...createInMemoryForwardSecrecyRepository(), keyStore: new ForwardSecrecyKeyStore(), clock });
  await fs.start({ sessionId, handshakeId, participants: ["alice", "bob"], rootSecret: secret });
  const rootSecret = fs.resolveEncryptionKeys(sessionId).ratchetMaterial;

  const chains = new ChainManager({ ...createInMemoryKeyHierarchyRepository(), keyStore: new KeyHierarchyKeyStore(), clock });
  await chains.establish({ sessionId, handshakeId, role: options.role ?? "initiator", rootSecret });

  const events = new MessageKeyEventBus();
  const cache = new MessageKeyCache({ clock });
  const manager = new MessageKeyManager({ ...createInMemoryMessageKeyRepository(), chainManager: chains, cache, events, clock, maxSkip: options.maxSkip });
  await manager.ensure(sessionId);
  const transport = createMessageKeyTransport({ messageKeyManager: manager });
  return { fs, chains, manager, cache, events, clock, transport, sessionId, secret };
}

/** Build an initiator+responder pair sharing one secret (interoperable chains). */
export async function makePair(seed = 1) {
  const secret = makeSecret(seed);
  const sessionId = makeSessionId(seed);
  const alice = await makePeer({ role: "initiator", sessionId, secret });
  const bob = await makePeer({ role: "responder", sessionId, secret });
  return { alice, bob, sessionId };
}

export function captureEvents(events) {
  const seen = [];
  const off = events.on("*", (e) => seen.push(e));
  seen.types = () => seen.map((e) => e.type);
  return { seen, off };
}
