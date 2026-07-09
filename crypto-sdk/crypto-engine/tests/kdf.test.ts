import { describe, it, expect } from "vitest";
import { SharedSecret, randomBytes, generateKeyPair, deriveSharedSecret } from "@securechat/crypto-sdk";
import {
  MasterKey,
  KeyDerivation,
  DerivationPurpose,
  deriveSessionKey,
  buildInfoLabel,
  DerivationError,
} from "../src/index.js";

describe("MasterKey", () => {
  it("derives deterministically for the same context", () => {
    const master = MasterKey.fromBytes(randomBytes(32));
    const a = master.deriveSymmetricKey({ context: "session", purpose: DerivationPurpose.ENCRYPTION });
    const b = master.deriveSymmetricKey({ context: "session", purpose: DerivationPurpose.ENCRYPTION });
    expect(a.bytes).toEqual(b.bytes);
  });

  it("separates keys by context, purpose, and version", () => {
    const master = MasterKey.fromBytes(randomBytes(32));
    const base = master.deriveBytes({ context: "session", purpose: DerivationPurpose.ENCRYPTION });
    expect(master.deriveBytes({ context: "file", purpose: DerivationPurpose.ENCRYPTION })).not.toEqual(base);
    expect(master.deriveBytes({ context: "session", purpose: DerivationPurpose.MAC })).not.toEqual(base);
    expect(master.deriveBytes({ context: "session", purpose: DerivationPurpose.ENCRYPTION, version: 2 })).not.toEqual(base);
  });

  it("supports hierarchical sub-master keys", () => {
    const root = MasterKey.random();
    const child = root.deriveMasterKey({ context: "subsystem", purpose: DerivationPurpose.GENERIC });
    const k1 = child.deriveSymmetricKey({ context: "a", purpose: DerivationPurpose.ENCRYPTION });
    const k2 = child.deriveSymmetricKey({ context: "b", purpose: DerivationPurpose.ENCRYPTION });
    expect(k1.bytes).not.toEqual(k2.bytes);
  });

  it("builds from shared secret and password", () => {
    const secret = SharedSecret.fromBytes(randomBytes(32));
    expect(MasterKey.fromSharedSecret(secret).deriveSymmetricKey({ context: "c", purpose: "p" }).length).toBe(32);
    const pw = MasterKey.fromPassword("hunter2", randomBytes(16), { cost: 1024 });
    expect(pw.deriveBytes({ context: "c", purpose: "p" })).toHaveLength(32);
  });

  it("rejects weak master material", () => {
    expect(() => MasterKey.fromBytes(randomBytes(8))).toThrow(DerivationError);
  });

  it("does not leak via JSON", () => {
    expect(JSON.stringify({ m: MasterKey.random() })).toBe(`{"m":"[MasterKey]"}`);
  });
});

describe("KeyDerivation engine", () => {
  it("derives independent keys per (context, purpose)", () => {
    const kd = KeyDerivation.random("securechat");
    const enc = kd.deriveSymmetricKey("file", DerivationPurpose.ENCRYPTION);
    const mac = kd.deriveSymmetricKey("file", DerivationPurpose.MAC);
    const session = kd.deriveSessionKey("peer-1");
    expect(enc.bytes).not.toEqual(mac.bytes);
    expect(session.bytes).not.toEqual(enc.bytes);
  });

  it("namespaces derivations (different namespace → different key)", () => {
    const master = MasterKey.fromBytes(randomBytes(32));
    const a = KeyDerivation.fromMasterKey(master, "ns-a").deriveSessionKey("x");
    const b = KeyDerivation.fromMasterKey(master, "ns-b").deriveSessionKey("x");
    expect(a.bytes).not.toEqual(b.bytes);
  });
});

describe("deriveSessionKey (from shared secret)", () => {
  it("both peers derive the same session key for the same context", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const sA = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const sB = deriveSharedSecret(bob.privateKey, alice.publicKey);
    expect(deriveSessionKey(sA, "peer-42").bytes).toEqual(deriveSessionKey(sB, "peer-42").bytes);
    expect(deriveSessionKey(sA, "peer-42").bytes).not.toEqual(deriveSessionKey(sA, "peer-99").bytes);
  });
});

describe("buildInfoLabel", () => {
  it("encodes namespace:context:purpose:version", () => {
    const label = new TextDecoder().decode(buildInfoLabel({ context: "session", purpose: "encryption" }));
    expect(label).toBe("securechat:session:encryption:v1");
  });
});
