/**
 * Test helpers for the Secure Transport Layer. Node built-ins only (no MongoDB, no
 * external deps). Not a test file.
 */

import crypto from "node:crypto";
import { SecureTransportManager } from "../manager/secureTransportManager.js";
import { SecureTransportEventBus } from "../events/events.js";
import { deriveSessionKeys } from "../../shs/session/derivation/sessionKeys.js";

/** Deterministic session keys derived like Sprint 3 (both devices share these). */
export function sessionKeys(seed = 1, keyId = "k1") {
  const secret = crypto.createHash("sha256").update(`secret-${seed}`).digest();
  const keys = deriveSessionKeys(secret, { handshakeId: `hs-${seed}`, participants: ["alice", "bob"], protocolVersion: "1.0" });
  return { encryptionKey: keys.encryptionKey, macKey: keys.macKey, keyId, generation: 0 };
}

/** Random (non-matching) keys — for wrong-key tests. */
export function randomKeys(keyId = "k1") {
  return { encryptionKey: crypto.randomBytes(32), macKey: crypto.randomBytes(32), keyId, generation: 0 };
}

/** A device transport manager (has keys → can encrypt/decrypt). */
export function deviceManager(keys, over = {}) {
  return new SecureTransportManager({ keyProvider: () => keys, events: new SecureTransportEventBus(), ...over });
}

/** A relay manager (no keys → cannot decrypt). */
export function relay() {
  return new SecureTransportManager();
}

export function captureEvents(events) {
  const seen = [];
  const off = events.on("*", (e) => seen.push(e));
  seen.types = () => seen.map((e) => e.type);
  return { seen, off };
}
