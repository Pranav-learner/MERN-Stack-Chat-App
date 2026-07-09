/**
 * @packageDocumentation
 *
 * # @securechat/crypto-sdk — Cryptography Foundation (Layer 2, Module 1)
 *
 * A self-contained, chat-agnostic cryptographic toolkit. It provides secure
 * randomness, encoding, hashing, key derivation, symmetric AEAD encryption,
 * X25519 key agreement, and Ed25519 signatures, plus typed key/payload objects
 * and a typed error hierarchy.
 *
 * This module deliberately has NO knowledge of messages, users, sessions,
 * sockets, JWTs, or databases. Future E2EE modules import these primitives; they
 * never re-implement crypto.
 *
 * ## Two ways to import
 *
 * Flat (tree-shakeable) named exports:
 * ```ts
 * import { encrypt, decrypt, generateKey, sha256 } from "@securechat/crypto-sdk";
 * ```
 *
 * Grouped namespaces (when you want the module boundary explicit):
 * ```ts
 * import { symmetric, hashing, keys } from "@securechat/crypto-sdk";
 * const k = symmetric.generateKey();
 * ```
 *
 * @example End-to-end round trip (agreement → derive → encrypt → sign)
 * ```ts
 * import {
 *   generateKeyPair, deriveSharedSecret,
 *   generateSigningKeyPair, sign, verify,
 *   encrypt, decrypt, bytesToUtf8,
 * } from "@securechat/crypto-sdk";
 *
 * const alice = generateKeyPair();          // X25519
 * const bob = generateKeyPair();            // X25519
 * const secretA = deriveSharedSecret(alice.privateKey, bob.publicKey);
 * const secretB = deriveSharedSecret(bob.privateKey, alice.publicKey);
 * const keyA = secretA.deriveKey({ info: "demo:v1" });
 * const keyB = secretB.deriveKey({ info: "demo:v1" });
 *
 * const payload = encrypt(keyA, "hello bob");
 * console.log(bytesToUtf8(decrypt(keyB, payload))); // "hello bob"
 *
 * const id = generateSigningKeyPair();      // Ed25519
 * const sig = sign(id.privateKey, "hello bob");
 * console.log(verify(id.publicKey, "hello bob", sig)); // true
 * ```
 */

// --- Flat re-exports (each name is unique across modules) ---
export * from "./constants/index.js";
export * from "./errors/index.js";
export * from "./encoding/index.js";
export * from "./utils/index.js";
export * from "./random/index.js";
export * from "./hashing/index.js";
export * from "./kdf/index.js";
export * from "./keys/index.js";
export * from "./symmetric/index.js";
export * from "./asymmetric/index.js";
export * from "./signatures/index.js";

// --- Grouped namespace exports (ergonomic, avoids name-guessing) ---
export * as constants from "./constants/index.js";
export * as errors from "./errors/index.js";
export * as encoding from "./encoding/index.js";
export * as utils from "./utils/index.js";
export * as random from "./random/index.js";
export * as hashing from "./hashing/index.js";
export * as kdf from "./kdf/index.js";
export * as keys from "./keys/index.js";
export * as symmetric from "./symmetric/index.js";
export * as asymmetric from "./asymmetric/index.js";
export * as signatures from "./signatures/index.js";
