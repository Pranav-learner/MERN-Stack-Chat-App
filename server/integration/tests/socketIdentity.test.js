import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { attachSocketIdentity } from "../socketIdentity.js";
import { buildStack, provision } from "./helpers.js";

/** Minimal fake Socket.IO socket. */
function fakeSocket(handshake) {
  return { handshake, data: {} };
}

describe("attachSocketIdentity — identity-aware sockets", () => {
  let stack;
  beforeEach(() => {
    stack = buildStack();
  });

  it("uses a verified JWT id (authenticated) over query.userId", async () => {
    const { deviceId } = await provision(stack, "user-1");
    const socket = fakeSocket({ query: { userId: "spoofed", deviceId }, auth: { token: "tok" } });
    const summary = await attachSocketIdentity(socket, {
      service: stack.service,
      verifyToken: (t) => (t === "tok" ? { id: "user-1" } : null),
    });
    assert.equal(summary.userId, "user-1"); // token id, not "spoofed"
    assert.equal(summary.authenticated, true);
    assert.equal(summary.deviceId, deviceId);
    assert.equal(summary.ready, true);
    assert.equal(socket.data.identity.userId, "user-1");
  });

  it("falls back to query.userId (unauthenticated) when no token", async () => {
    await provision(stack, "user-1");
    const socket = fakeSocket({ query: { userId: "user-1" }, auth: {} });
    const summary = await attachSocketIdentity(socket, { service: stack.service, verifyToken: () => null });
    assert.equal(summary.userId, "user-1");
    assert.equal(summary.authenticated, false);
    assert.equal(summary.provisioned, true);
  });

  it("returns null when there is no user at all", async () => {
    const socket = fakeSocket({ query: {}, auth: {} });
    assert.equal(await attachSocketIdentity(socket, { service: stack.service, verifyToken: () => null }), null);
  });

  it("exposes device trust + fingerprint in the summary", async () => {
    const { deviceId } = await provision(stack, "user-1");
    const socket = fakeSocket({ query: { userId: "user-1", deviceId }, auth: {} });
    const summary = await attachSocketIdentity(socket, { service: stack.service, verifyToken: () => null });
    assert.equal(summary.deviceTrust, "trusted");
    assert.match(summary.fingerprint, /^[0-9a-f]{64}$/);
  });
});
