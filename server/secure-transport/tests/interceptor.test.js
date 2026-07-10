import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSecureTransportInterceptor } from "../interceptor/secureTransportInterceptor.js";
import { isSecurePayload } from "../payload/securePayload.js";
import {
  setEncryptionInterceptor,
  resetEncryptionInterceptor,
  isEncryptionActive,
} from "../../session-integration/interceptors/encryptionInterceptor.js";
import { prepareSecurePayload } from "../../session-integration/transport/securePayload.js";
import { sessionKeys } from "./helpers.js";

describe("Secure Transport interceptor (activates E2E in the Sprint 5 pipeline)", () => {
  afterEach(() => resetEncryptionInterceptor());

  it("seals an outbound envelope when a session backs it", () => {
    const k = sessionKeys();
    const interceptor = createSecureTransportInterceptor({ keyProvider: () => k });
    const env = interceptor.encryptOutbound(
      { payload: { text: "hi" }, fallback: false },
      { sessionId: "s1", resolved: true, senderDevice: "devA", receiverDevice: "devB" },
    );
    assert.equal(env.secured, true);
    assert.equal(env.payload, null); // plaintext removed
    assert.equal(isSecurePayload(env.encryption), true);
    // round-trip via decryptInbound
    const opened = interceptor.decryptInbound(env, { sessionId: "s1" });
    assert.deepEqual(opened.payload, { text: "hi" });
  });

  it("does NOT encrypt a fallback (session-less) envelope", () => {
    const interceptor = createSecureTransportInterceptor({ keyProvider: () => sessionKeys() });
    const env = interceptor.encryptOutbound({ payload: { text: "hi" }, fallback: true }, { sessionId: null, resolved: false });
    assert.equal(env.secured, false);
    assert.equal(env.encryption, null);
    assert.deepEqual(env.payload, { text: "hi" });
  });

  it("registering it turns prepareSecurePayload into real encryption (Layer 5 activation)", async () => {
    const k = sessionKeys();
    assert.equal(isEncryptionActive(), false);
    setEncryptionInterceptor(createSecureTransportInterceptor({ keyProvider: () => k }));
    assert.equal(isEncryptionActive(), true);

    const envelope = await prepareSecurePayload(
      { text: "e2e via pipeline" },
      { sessionId: "s1", keyId: k.keyId, resolved: true, transportMode: "session", initiator: "alice", peer: "bob", senderDevice: "devA", receiverDevice: "devB" },
    );
    assert.equal(envelope.secured, true);
    assert.equal(envelope.payload, null);
    assert.equal(isSecurePayload(envelope.encryption), true);
    assert.equal(JSON.stringify(envelope).includes("e2e via pipeline"), false);
  });
});
