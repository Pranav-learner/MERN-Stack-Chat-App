/**
 * Test helpers — real Ed25519 identities + an in-memory identity store that the
 * TrustManager can look up (mimics Sprint 1 IdentityManager.getIdentityByUser).
 * Node built-ins only. Not a test file.
 */
import crypto from "node:crypto";

/** Generate a real Ed25519 identity descriptor for a user. */
export function makeIdentity(userId) {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return {
    userId: String(userId),
    identityId: `id-${userId}`,
    publicKey: raw.toString("base64"),
    algorithm: "ed25519",
    raw,
    fingerprint: crypto.createHash("sha256").update(raw).digest("hex"),
  };
}

/** A mutable in-memory identity store with an async `lookup(userId)`. */
export function makeIdentityStore() {
  const map = new Map();
  return {
    add(userId) {
      const id = makeIdentity(userId);
      map.set(String(userId), id);
      return id;
    },
    set(userId, identity) {
      map.set(String(userId), identity);
      return identity;
    },
    /** Replace a user's identity with a fresh key (simulates identity change). */
    rotate(userId) {
      return this.set(userId, makeIdentity(userId));
    },
    remove(userId) {
      map.delete(String(userId));
    },
    lookup: async (userId) => map.get(String(userId)) ?? null,
  };
}

/** Fast safety-number options for tests. */
export const FAST_SN = { iterations: 64 };
