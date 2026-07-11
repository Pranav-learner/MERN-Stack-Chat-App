/**
 * Flow control + backpressure (Layer 8, Sprint 2): the sliding window bounds outstanding chunks, the
 * receiver advertises a window, and memory pressure paces (never deadlocks) the sender. Unit + engine
 * level. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeMesh, fakeCiphertext } from "./helpers.js";
import { FlowController } from "../flow-control/flowController.js";
import { ReceiverBackpressure, SenderResourceGuard } from "../buffering/backpressure.js";
import { BackpressureState, TransferState } from "../types/types.js";

describe("FlowController (unit)", () => {
  it("bounds outstanding chunks to the effective window", () => {
    const fc = new FlowController({ windowSize: 3, receiverWindow: 10 });
    assert.equal(fc.effectiveWindow, 3);
    fc.onSent("a");
    fc.onSent("b");
    fc.onSent("c");
    assert.equal(fc.canSend(), false, "window full");
    fc.onAcked("b");
    assert.equal(fc.canSend(), true, "ack freed a slot");
    assert.equal(fc.available, 1);
  });

  it("uses the smaller of sender + receiver windows", () => {
    const fc = new FlowController({ windowSize: 8, receiverWindow: 2 });
    assert.equal(fc.effectiveWindow, 2);
    fc.setReceiverWindow(16);
    assert.equal(fc.effectiveWindow, 8);
  });

  it("pause() blocks sending; resume() restores it", () => {
    const fc = new FlowController({ windowSize: 4 });
    fc.pause();
    assert.equal(fc.canSend(), false);
    assert.equal(fc.backpressure, BackpressureState.PAUSED);
    fc.resume();
    assert.equal(fc.canSend(), true);
  });

  it("a 0 receiver window pauses the sender (hard backpressure)", () => {
    const fc = new FlowController({ windowSize: 4, receiverWindow: 0 });
    assert.equal(fc.canSend(), false);
    assert.equal(fc.backpressure, BackpressureState.PAUSED);
  });

  it("adaptive/congestion hooks are inert placeholders", () => {
    const fc = new FlowController({ windowSize: 5 });
    assert.equal(fc.adaptWindow(), 5);
    assert.equal(fc.congested(), false);
  });
});

describe("ReceiverBackpressure (unit)", () => {
  it("scales the advertised window down as the buffer fills, never below 1", () => {
    const bp = new ReceiverBackpressure({ maxBufferedBytes: 1000, receiverWindow: 32 });
    assert.equal(bp.advertisedWindow(), 32);
    bp.onBuffered(900); // near full
    assert.ok(bp.advertisedWindow() >= 1 && bp.advertisedWindow() < 32, "reduced but non-zero");
    assert.equal(bp.state, BackpressureState.SLOW);
  });

  it("engages + releases the slow signal across the low-water mark", () => {
    const bp = new ReceiverBackpressure({ maxBufferedBytes: 1000, receiverWindow: 8, lowWaterRatio: 0.5 });
    assert.equal(bp.onBuffered(600), true, "just engaged");
    assert.equal(bp.onBuffered(100), false, "already engaged");
    assert.equal(bp.onDrained(500), true, "just released");
  });

  it("explicit pause advertises a 0 window; resume restores it", () => {
    const bp = new ReceiverBackpressure({ maxBufferedBytes: 1_000_000, receiverWindow: 8 });
    bp.pause();
    assert.equal(bp.advertisedWindow(), 0);
    assert.equal(bp.state, BackpressureState.PAUSED);
    bp.resume();
    assert.ok(bp.advertisedWindow() >= 1);
  });
});

describe("SenderResourceGuard (unit)", () => {
  it("caps queue depth + in-flight bytes (memory protection)", () => {
    const g = new SenderResourceGuard({ maxQueueDepth: 2, maxInFlightBytes: 100 });
    assert.equal(g.admit(0, 50), true);
    assert.equal(g.admit(2, 50), false, "queue depth cap");
    g.reserve(80);
    assert.equal(g.admit(0, 50), false, "would exceed in-flight bytes");
    g.release(80);
    assert.equal(g.admit(0, 50), true);
  });
});

describe("engine-level flow control", () => {
  let mesh;
  beforeEach(() => {
    mesh = makeMesh({ options: { windowSize: 3, chunkSize: 32 * 1024 } });
  });

  it("never has more than windowSize chunks outstanding at once", async () => {
    const payload = fakeCiphertext(320 * 1024, 4); // 10 chunks, window 3
    const { transfer } = await mesh.engines.alice.startTransfer({ conversationId: "c", receiverDeviceId: "bob", payload, payloadMeta: { kind: "file" } });
    // pump() ran during startTransfer, before any ack is processed → outstanding capped at the window.
    const diag = await mesh.engines.alice.getDiagnostics(transfer.transferId);
    assert.ok(diag.outstanding <= 3, `outstanding ${diag.outstanding} <= 3`);
    assert.equal(diag.pending, transfer.payloadMeta.totalChunks - diag.outstanding);
    // Drain fully.
    await mesh.net.flush();
    const done = await mesh.engines.alice.getTransfer(transfer.transferId);
    assert.equal(done.state, TransferState.COMPLETED);
  });

  it("still completes a payload larger than the receiver buffer (slow, not stalled)", async () => {
    // Tiny receive buffer forces the SLOW path repeatedly; must not deadlock.
    const mesh2 = makeMesh({ options: { windowSize: 2, chunkSize: 16 * 1024, maxBufferedBytes: 32 * 1024 } });
    const payload = fakeCiphertext(256 * 1024, 6); // 16 chunks, buffer only fits ~2
    const { transfer } = await mesh2.engines.alice.startTransfer({ conversationId: "c", receiverDeviceId: "bob", payload, payloadMeta: { kind: "file" } });
    await mesh2.net.flush();
    assert.ok(Buffer.from(mesh2.received.bob[0].payload, "base64").equals(payload), "delivered intact despite backpressure");
    assert.equal((await mesh2.engines.alice.getTransfer(transfer.transferId)).state, TransferState.COMPLETED);
  });
});
