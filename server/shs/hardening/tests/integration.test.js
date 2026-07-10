/**
 * End-to-end hardening integration: wires the Sprint 4 protections around the real
 * Sprint 1–3 managers and exercises attack scenarios, large-scale simulation, and a
 * perf sanity check.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { HandshakeManager } from "../../manager/handshakeManager.js";
import { createInMemoryShsRepository } from "../../repository/inMemoryRepository.js";
import { KeyAgreementManager } from "../../key-agreement/manager/keyAgreementManager.js";
import { createInMemoryKeyAgreementRepositories } from "../../key-agreement/repository/inMemoryRepository.js";
import { SecureSessionManager } from "../../session/manager/sessionManager.js";
import { createInMemorySessionRepository } from "../../session/repository/inMemoryRepository.js";
import { SecureKeyStore } from "../../session/storage/secureKeyStore.js";

import { ReplayProtector } from "../replay/replayProtector.js";
import { assertNoDowngrade } from "../downgrade/downgradeGuard.js";
import { verifyInboundMessage, TranscriptAccumulator } from "../integrity/protocolIntegrity.js";
import { SessionGuard } from "../session-guard/sessionGuard.js";
import { HealthMonitor } from "../observability/healthMonitor.js";
import { HardeningEventBus } from "../events/events.js";
import { hardenRepository } from "../repository/hardenedRepository.js";
import { runBenchmark } from "../perf/benchmark.js";
import { HandshakeEventBus } from "../../events/events.js";
import { ReplayDetectedError } from "../errors.js";

function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  const c = () => now;
  c.advance = (ms) => (now += ms);
  return c;
}

describe("hardening — end-to-end protected handshake → key agreement → session", () => {
  it("runs a full protected flow with replay, downgrade, integrity, guard, metrics", async () => {
    const clock = fakeClock();
    const hardeningEvents = new HardeningEventBus();
    const handshakeEvents = new HandshakeEventBus();

    // Sprint 1–3 managers.
    const shs = createInMemoryShsRepository();
    const handshakes = new HandshakeManager({ ...shs, events: handshakeEvents, clock });
    const relay = createInMemoryKeyAgreementRepositories();
    const ka = new KeyAgreementManager({ exchanges: relay.exchanges, sessions: shs.sessions, clock });
    const aliceRepos = createInMemoryKeyAgreementRepositories();
    const bobRepos = createInMemoryKeyAgreementRepositories();
    const aliceKA = new KeyAgreementManager({ exchanges: relay.exchanges, material: aliceRepos.material, clock });
    const bobKA = new KeyAgreementManager({ exchanges: relay.exchanges, material: bobRepos.material, clock });

    // Sprint 4 hardening.
    const replay = new ReplayProtector({ clock, events: hardeningEvents });
    const guard = new SessionGuard({ clock });
    const health = new HealthMonitor().attach({ handshakes: handshakeEvents, hardening: hardeningEvents });

    // 1. handshake with replay + integrity protection on the request message.
    const { session, message } = await handshakes.startHandshake({ initiator: "alice", responder: "bob", initiatorDevice: "devA" });
    const hsId = session.handshakeId;
    const record = await shs.sessions.findById(hsId);
    const transcript = new TranscriptAccumulator(hsId);
    verifyInboundMessage(message, record, { transcript });
    assert.equal(replay.accept(message).ok, true);
    assert.throws(() => replay.accept(message), ReplayDetectedError); // replayed request blocked

    await handshakes.acceptHandshake(hsId, "bob", {});

    // 2. key agreement with downgrade protection on the negotiation.
    assertNoDowngrade({
      initiatorOffer: { supportedVersions: ["1.0"], algorithms: ["x25519"] },
      responderOffer: { supportedVersions: ["1.0"], algorithms: ["x25519"] },
      negotiated: { version: "1.0", algorithm: "x25519" },
    });
    await ka.negotiate(hsId, { initiator: "alice", responder: "bob", initiatorOffer: { algorithms: ["x25519"] }, responderOffer: { algorithms: ["x25519"] } });
    await ka.submitEphemeralKey(hsId, "initiator", aliceKA.generateEphemeralKeys(hsId, "initiator"));
    await ka.submitEphemeralKey(hsId, "responder", bobKA.generateEphemeralKeys(hsId, "responder"));
    const aDer = await aliceKA.deriveAndStore(hsId, "initiator", (await aliceKA.getPeerKey(hsId, "initiator")).publicKey);
    const bDer = await bobKA.deriveAndStore(hsId, "responder", (await bobKA.getPeerKey(hsId, "responder")).publicKey);
    await ka.submitCommitment(hsId, "initiator", aDer.commitment);
    await ka.submitCommitment(hsId, "responder", bDer.commitment);
    assert.equal((await handshakes.getHandshake(hsId)).state, "cryptographically_complete");

    // 3. session establishment + continuous guard.
    const sessions = new SecureSessionManager({ ...createInMemorySessionRepository(), keyStore: new SecureKeyStore(), clock });
    const secureSession = await sessions.establishSession({
      handshakeId: hsId,
      participants: ["alice", "bob"],
      deviceIds: { initiator: "devA", responder: "devB" },
      sharedSecret: await aliceKA.loadSharedSecret(hsId),
    });
    await guard.assert(secureSession, { actingUser: "alice" });

    // health snapshot reflects the flow.
    const h = health.health();
    assert.ok(h.signals.started >= 1);
    assert.ok(h.signals.replaysDetected >= 1);
    health.detach();
  });

  it("blocks a downgrade attack in the negotiation path", () => {
    assert.throws(
      () =>
        assertNoDowngrade({
          initiatorOffer: { supportedVersions: ["1.0", "1.1"], capabilities: ["handshake.resume"] },
          responderOffer: { supportedVersions: ["1.0", "1.1"], capabilities: ["handshake.resume"] },
          negotiated: { version: "1.0", capabilities: [] }, // stripped + not max-common
        }),
      /Downgrade blocked/,
    );
  });
});

describe("hardening — large-scale simulation + stress", () => {
  it("100 concurrent protected handshakes: unique ids, replay-safe, health healthy", async () => {
    const clock = fakeClock();
    const events = new HandshakeEventBus();
    const hardeningEvents = new HardeningEventBus();
    const handshakes = new HandshakeManager({ ...createInMemoryShsRepository(), events, clock });
    const replay = new ReplayProtector({ clock, events: hardeningEvents });
    const health = new HealthMonitor().attach({ handshakes: events, hardening: hardeningEvents });

    const N = 100;
    const started = await Promise.all(
      Array.from({ length: N }, (_, i) => handshakes.startHandshake({ initiator: `u${i}`, responder: `v${i}`, initiatorDevice: "d" })),
    );
    // all handshake ids + message ids unique; each message accepted exactly once.
    assert.equal(new Set(started.map((s) => s.session.handshakeId)).size, N);
    let accepted = 0;
    for (const { message } of started) if (replay.accept(message).ok) accepted++;
    assert.equal(accepted, N);
    // complete them all
    await Promise.all(started.map(({ session }) => handshakes.acceptHandshake(session.handshakeId, session.responder, {})));
    await Promise.all(started.map(({ session }) => handshakes.completeHandshake(session.handshakeId, session.initiator)));
    const h = health.health();
    assert.equal(h.signals.completed, N);
    assert.equal(h.status, "healthy");
    health.detach();
  });

  it("hardened repository stays consistent under concurrent updates (no lost writes)", async () => {
    const base = createInMemorySessionRepository().sessions;
    const repo = hardenRepository(base, { idOf: (r) => r.sessionId });
    await repo.create({ sessionId: "sess-stress1", status: "active", counter: 0 });
    // 100 concurrent read-modify-write increments made atomic by the keyed mutex.
    // (Operate on the base repo inside the lock — KeyedMutex is not reentrant, so we
    // must not call the hardened repo's own mutex-guarded methods here.)
    await Promise.all(
      Array.from({ length: 100 }, () =>
        repo.mutex.run("sess-stress1", async () => {
          const cur = await base.findById("sess-stress1");
          await base.update("sess-stress1", { counter: (cur.counter ?? 0) + 1 });
        }),
      ),
    );
    const final = await base.findById("sess-stress1");
    assert.equal(final.counter, 100);
  });
});

describe("hardening — performance sanity (regression guard)", () => {
  it("benchmarks the hot paths and reports positive throughput", async () => {
    const rows = await runBenchmark({ iterations: 50 });
    assert.ok(rows.length >= 4);
    for (const row of rows) {
      assert.ok(row.opsPerSec > 0, `${row.name} throughput`);
      assert.ok(row.p99 >= 0);
    }
    // session lookup should be fast (cached path in the repo is O(1)).
    const lookup = rows.find((r) => r.name === "session.lookup");
    assert.ok(lookup.opsPerSec > 100, `session.lookup ops/sec = ${lookup.opsPerSec}`);
  });
});
