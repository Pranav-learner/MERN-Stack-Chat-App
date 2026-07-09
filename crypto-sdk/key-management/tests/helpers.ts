import { generateSigningKeyPair } from "@securechat/crypto-sdk";
import {
  ManagedKey,
  KeyManager,
  KeyMaterialKind,
  KeyPurpose,
  KeyStatus,
  KeyType,
  computeFingerprint,
  createKeyMetadata,
  systemClock,
  type IdGenerator,
} from "../src/index.js";

/** Deterministic, unique id generator for tests. */
export function counterIdGenerator(prefix = "k"): IdGenerator {
  let n = 0;
  return () => `${prefix}_${++n}`;
}

/** A KeyManager wired with a deterministic id generator (random material still). */
export function testManager(): KeyManager {
  return new KeyManager({ idGenerator: counterIdGenerator() });
}

/** Build a valid identity ManagedKey directly (bypassing the manager). */
export function makeIdentityKey(owner = "owner-1", keyId = "id_1"): ManagedKey {
  const keyPair = generateSigningKeyPair();
  const material = { kind: KeyMaterialKind.KEYPAIR as const, keyPair };
  const metadata = createKeyMetadata(
    {
      type: KeyType.IDENTITY,
      algorithm: keyPair.algorithm,
      purpose: KeyPurpose.SIGNING,
      owner,
      fingerprint: computeFingerprint(material),
      keyId,
      status: KeyStatus.ACTIVE,
    },
    { clock: systemClock, idGenerator: () => keyId },
  );
  return new ManagedKey({ metadata, material });
}
