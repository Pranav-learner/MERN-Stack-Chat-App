import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TransportMode, PipelineStage, IntegrationEventType } from "../types.js";
import { HandshakeRequiredError, TransportUnavailableError, PipelineInputError } from "../errors.js";
import {
  prepareSecurePayload,
  sessionMetadataOf,
} from "../transport/securePayload.js";
import {
  setEncryptionInterceptor,
  resetEncryptionInterceptor,
  isEncryptionActive,
  getEncryptionInterceptor,
} from "../interceptors/encryptionInterceptor.js";
import { makeStack, establishBetween, recordingTransport } from "./helpers.js";

describe("secure payload + encryption hook", () => {
  afterEach(() => resetEncryptionInterceptor());

  it("prepares an unsecured envelope with session metadata (Layer 4)", async () => {
    const ctx = { resolved: true, sessionId: "s1", keyId: "k1", transportMode: TransportMode.SESSION, initiator: "a", peer: "b", resolution: "resolved" };
    const env = await prepareSecurePayload({ text: "hi" }, ctx);
    assert.equal(env.secured, false);
    assert.equal(env.encryption, null);
    assert.equal(env.sessionId, "s1");
    assert.equal(env.keyId, "k1");
    assert.equal(env.payload.text, "hi");
    assert.deepEqual(sessionMetadataOf(env), { sessionId: "s1", keyId: "k1", secured: false, transportMode: "session", fallback: false });
  });

  it("the interceptor is the extension point Layer 5 fills (no-op by default)", async () => {
    assert.equal(isEncryptionActive(), false);
    assert.equal(getEncryptionInterceptor().name, "noop");
    setEncryptionInterceptor({
      name: "aes-256-gcm",
      encryptOutbound: (e) => ({ ...e, secured: true, encryption: { algorithm: "aes-256-gcm", ciphertext: "<c>" }, payload: null }),
      decryptInbound: (e) => e,
    });
    assert.equal(isEncryptionActive(), true);
    const env = await prepareSecurePayload({ text: "secret" }, { transportMode: TransportMode.SESSION });
    assert.equal(env.secured, true);
    assert.equal(env.payload, null);
    assert.equal(env.encryption.algorithm, "aes-256-gcm");
  });

  it("rejects a malformed interceptor", () => {
    assert.throws(() => setEncryptionInterceptor({ name: "bad" }), /encryptOutbound/);
  });
});

describe("MessagePipeline", () => {
  let stack;
  let transport;
  beforeEach(() => {
    stack = makeStack();
    transport = recordingTransport();
  });
  afterEach(() => resetEncryptionInterceptor());

  it("delivers via fallback when no session exists (permissive)", async () => {
    const events = [];
    stack.appSessions.events.on("*", (e) => events.push(e.type));
    const result = await stack.pipeline.process({ sender: "alice", recipient: "bob", message: { text: "hi" }, transport });
    assert.equal(result.stage, PipelineStage.DELIVERED);
    assert.equal(result.envelope.transportMode, TransportMode.FALLBACK);
    assert.equal(result.envelope.secured, false);
    assert.equal(transport.delivered.length, 1);
    assert.ok(events.includes(IntegrationEventType.MESSAGE_PIPELINED));
    assert.ok(events.includes(IntegrationEventType.PIPELINE_FALLBACK));
  });

  it("delivers session-backed when a session exists", async () => {
    await establishBetween(stack.appSessions, "alice", "bob");
    const result = await stack.pipeline.process({ sender: "alice", recipient: "bob", message: { text: "yo" }, transport });
    assert.equal(result.envelope.transportMode, TransportMode.SESSION);
    assert.ok(result.envelope.keyId);
    assert.equal(result.envelope.secured, false); // still no encryption in Layer 4
    assert.equal(transport.delivered[0].sessionId, result.context.sessionId);
  });

  it("Layer 5 encryption plugs in with ZERO pipeline change", async () => {
    await establishBetween(stack.appSessions, "alice", "bob");
    setEncryptionInterceptor({
      name: "aes-256-gcm",
      encryptOutbound: (e) => ({ ...e, secured: true, encryption: { algorithm: "aes-256-gcm" }, payload: null }),
      decryptInbound: (e) => e,
    });
    const result = await stack.pipeline.process({ sender: "alice", recipient: "bob", message: { text: "secret" }, transport });
    assert.equal(result.stage, PipelineStage.DELIVERED); // same pipeline outcome
    assert.equal(result.envelope.secured, true);
    assert.equal(result.envelope.payload, null); // plaintext no longer present
  });

  it("STRICT mode rejects when no session (handshake required)", async () => {
    const strict = makeStack({ enforcement: "strict" });
    await assert.rejects(
      () => strict.pipeline.process({ sender: "a", recipient: "b", message: { text: "x" }, transport }),
      HandshakeRequiredError,
    );
  });

  it("validates input + surfaces transport failures", async () => {
    await assert.rejects(() => stack.pipeline.process({ recipient: "b", message: {}, transport }), PipelineInputError);
    await assert.rejects(() => stack.pipeline.process({ sender: "a", recipient: "a", message: {}, transport }), PipelineInputError);
    const failing = async () => {
      throw new Error("db down");
    };
    await assert.rejects(() => stack.pipeline.process({ sender: "a", recipient: "b", message: {}, transport: failing }), TransportUnavailableError);
  });
});
