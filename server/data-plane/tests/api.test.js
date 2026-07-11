/**
 * The data-plane service facade (Layer 8, Sprint 1): assembly, send/status/history/diagnostics,
 * scheduler control, and reconnect flush. DB-free.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeClock, makeIdGen, cipher } from "./helpers.js";
import { createDataPlaneService } from "../api/messagingApi.js";
import { createInMemoryMessageRepository } from "../repository/inMemoryMessageRepository.js";
import { createLoopbackTransport } from "../transport/wire.js";
import { DeliveryState } from "../types/types.js";

function makePair() {
  const registry = new Map();
  const link = { up: true };
  const transport = createLoopbackTransport({ route: (id) => registry.get(id)?.engine, up: () => link.up });
  const clock = makeClock();
  const idGen = makeIdGen();
  const a = createDataPlaneService({ deviceId: "a", transport, repository: createInMemoryMessageRepository(), clock: clock.now, idGenerator: idGen });
  const b = createDataPlaneService({ deviceId: "b", transport, repository: createInMemoryMessageRepository(), clock: clock.now, idGenerator: idGen });
  registry.set("a", a);
  registry.set("b", b);
  return { a, b, link, clock };
}

describe("DataPlaneService facade", () => {
  let ctx;
  beforeEach(() => {
    ctx = makePair();
  });

  it("assembles an engine + scheduler and requires deviceId + transport", () => {
    assert.equal(ctx.a.deviceId, "a");
    assert.ok(ctx.a.engine);
    assert.ok(ctx.a.scheduler);
    assert.throws(() => createDataPlaneService({ transport: { send: async () => {} } }), /deviceId/);
    assert.throws(() => createDataPlaneService({ deviceId: "x" }), /transport/);
  });

  it("sends, tracks status, and exposes history + diagnostics", async () => {
    const delivered = [];
    ctx.b.onMessage((d) => delivered.push(d));
    const { message } = await ctx.a.send({ conversationId: "conv1", receiverDeviceId: "b", encryptedPayload: cipher("hi") });
    assert.equal(delivered.length, 1);

    const status = await ctx.a.getStatus(message.messageId);
    assert.equal(status.state, DeliveryState.ACKNOWLEDGED);

    const history = await ctx.a.getHistory("conv1");
    assert.equal(history.length, 1);
    assert.equal(history[0].encryptedPayload, undefined, "history items carry no payload");

    const diag = await ctx.a.getDiagnostics("conv1");
    assert.equal(diag.conversationId, "conv1");
    assert.ok(diag.countsByState);
  });

  it("start()/stop() control the retransmission scheduler without keeping the loop alive", () => {
    ctx.a.start();
    assert.equal(ctx.a.scheduler.isRunning, true);
    ctx.a.stop();
    assert.equal(ctx.a.scheduler.isRunning, false);
  });

  it("flushes pending messages after a reconnect", async () => {
    const delivered = [];
    ctx.b.onMessage((d) => delivered.push(d));
    ctx.link.up = false;
    const { message } = await ctx.a.send({ conversationId: "conv1", receiverDeviceId: "b", encryptedPayload: cipher() });
    assert.equal((await ctx.a.getStatus(message.messageId)).state, DeliveryState.QUEUED);
    ctx.link.up = true;
    await ctx.a.flushPending();
    assert.equal((await ctx.a.getStatus(message.messageId)).state, DeliveryState.ACKNOWLEDGED);
    assert.equal(delivered.length, 1);
  });
});
