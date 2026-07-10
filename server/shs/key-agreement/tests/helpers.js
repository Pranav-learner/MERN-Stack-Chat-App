/**
 * Test helpers for the Secure Key Agreement subsystem. Node built-ins only (no
 * MongoDB, no external deps). Not a test file.
 */

import crypto from "node:crypto";
import { KeyAgreementManager } from "../manager/keyAgreementManager.js";
import { createInMemoryKeyAgreementRepositories } from "../repository/inMemoryRepository.js";
import { KeyAgreementEventBus } from "../events/keyAgreementEvents.js";
import { createInMemoryShsRepository } from "../../repository/inMemoryRepository.js";
import { HandshakeManager } from "../../manager/handshakeManager.js";

/** A controllable clock: `clock()` reads current ms; `advance(ms)` moves it forward. */
export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => (now += ms);
  clock.set = (ms) => (now = ms);
  return clock;
}

/** Deterministic id generator. */
export function makeIdGen(prefix = "id") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** A real Ed25519 identity descriptor (for authenticated-KE tests). */
export function makeIdentity(userId) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return { userId: String(userId), identityId: `id-${userId}`, publicKey: raw.toString("base64"), algorithm: "ed25519", privateKey };
}

/**
 * A realistic scenario: a shared PUBLIC relay + two device managers (Alice, Bob),
 * each with its own local material store, all sharing the relay's `exchanges` repo,
 * optionally driving an SHS handshake session.
 *
 * @param {{ withHandshake?: boolean, requireSignature?: boolean, ttlMs?: number }} [options]
 */
export function makeScenario(options = {}) {
  const clock = makeClock();
  const events = new KeyAgreementEventBus();
  const relay = createInMemoryKeyAgreementRepositories();

  let sessions = null;
  let handshakeManager = null;
  let handshakeId = "hs-fixed-1";
  if (options.withHandshake) {
    const shs = createInMemoryShsRepository();
    sessions = shs.sessions;
    handshakeManager = new HandshakeManager({ sessions, clock, idGenerator: makeIdGen("hs") });
  }

  const server = new KeyAgreementManager({
    exchanges: relay.exchanges,
    sessions,
    events,
    clock,
    idGenerator: makeIdGen("ex"),
    ttlMs: options.ttlMs,
    requireSignature: options.requireSignature,
  });

  const aliceRepos = createInMemoryKeyAgreementRepositories();
  const bobRepos = createInMemoryKeyAgreementRepositories();
  // Devices share the same event bus in tests so a single capture sees every event
  // (in production each device has its own in-process bus).
  const alice = new KeyAgreementManager({ exchanges: relay.exchanges, material: aliceRepos.material, events, clock, idGenerator: makeIdGen("a") });
  const bob = new KeyAgreementManager({ exchanges: relay.exchanges, material: bobRepos.material, events, clock, idGenerator: makeIdGen("b") });

  return { clock, events, relay, sessions, handshakeManager, server, alice, bob, aliceRepos, bobRepos, handshakeId };
}

/** Drive an SHS handshake to `negotiating` and return its id. */
export async function negotiatedHandshake(handshakeManager) {
  const started = await handshakeManager.startHandshake({ initiator: "alice", responder: "bob", initiatorDevice: "dev-a" });
  await handshakeManager.acceptHandshake(started.session.handshakeId, "bob", {});
  return started.session.handshakeId;
}

/**
 * Run a full successful key agreement for a handshakeId across the relay + two
 * devices. Returns the derived fingerprints + final exchange.
 */
export async function runFullAgreement({ server, alice, bob, handshakeId }) {
  await server.negotiate(handshakeId, {
    initiator: "alice",
    responder: "bob",
    initiatorOffer: { algorithms: ["x25519"] },
    responderOffer: { algorithms: ["x25519"] },
  });
  const aBundle = alice.generateEphemeralKeys(handshakeId, "initiator");
  await server.submitEphemeralKey(handshakeId, "initiator", aBundle);
  const bBundle = bob.generateEphemeralKeys(handshakeId, "responder");
  await server.submitEphemeralKey(handshakeId, "responder", bBundle);

  const aPeer = await alice.getPeerKey(handshakeId, "initiator");
  const bPeer = await bob.getPeerKey(handshakeId, "responder");
  const aDer = await alice.deriveAndStore(handshakeId, "initiator", aPeer.publicKey);
  const bDer = await bob.deriveAndStore(handshakeId, "responder", bPeer.publicKey);

  await server.submitCommitment(handshakeId, "initiator", aDer.commitment);
  const exchange = await server.submitCommitment(handshakeId, "responder", bDer.commitment);
  return { aDer, bDer, exchange };
}

export function captureEvents(events) {
  const seen = [];
  const off = events.on("*", (e) => seen.push(e));
  seen.types = () => seen.map((e) => e.type);
  return { seen, off };
}
