/**
 * Shared test helpers for the Media Delivery (Layer 11, Sprint 2) suite. DB-free — everything runs under
 * `node --test` with an in-memory delivery repo over a REAL Sprint-1 MediaManager (in-memory repo +
 * in-memory storage provider), so the tests exercise the true integration without mongoose.
 */

import { MediaManager } from "../../media/manager/mediaManager.js";
import { createInMemoryMediaRepository } from "../../media/repository/inMemoryMediaRepository.js";
import { createInMemoryStorageProvider } from "../../media/providers/inMemoryStorageProvider.js";
import { generateMediaKey, encryptMedia, decryptMedia, mediaKeyFingerprint, sha256 } from "../../media/encryption/mediaEncryption.js";
import { MediaDeliveryEngine } from "../manager/mediaDeliveryEngine.js";
import { createInMemoryDeliveryRepository } from "../repository/inMemoryDeliveryRepository.js";
import { createDeliveryApi } from "../api/deliveryApi.js";
import { MediaDeliveryEventBus } from "../events/events.js";

export function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

/** Build a Sprint-1 manager + Sprint-2 delivery engine + api with a captured event log. */
export function makeEngine(options = {}) {
  const clock = options.clock ?? makeClock();
  const mediaManager = new MediaManager({ ...createInMemoryMediaRepository(), storageProvider: createInMemoryStorageProvider(), clock: clock.now });
  const repo = createInMemoryDeliveryRepository();
  const events = new MediaDeliveryEventBus();
  const engine = new MediaDeliveryEngine({ ...repo, mediaManager, events, clock: clock.now, chunkSize: options.chunkSize ?? 256 * 1024, parallel: options.parallel, thumbnailGenerator: options.thumbnailGenerator, previewGenerator: options.previewGenerator });
  const api = createDeliveryApi(engine);
  const captured = [];
  events.on("*", (e) => captured.push(e));
  return { engine, api, mediaManager, repo, events, clock, captured };
}

/** DEVICE-SIDE: encrypt + upload a media object to Sprint 1, returning its id + key + plaintext. */
export async function uploadMedia(mediaManager, plaintext, { filename = "file.bin", contentType = "application/octet-stream", conversationId = "conv1", ownerId = "alice" } = {}) {
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const key = generateMediaKey();
  const enc = encryptMedia(pt, key);
  const up = await mediaManager.uploadMedia({ ownerId, conversationId, filename, contentType, ciphertext: enc.ciphertext, plaintextHash: enc.plaintextHash, plaintextSize: pt.length, encryption: { keyFingerprint: mediaKeyFingerprint(key), iv: enc.iv.toString("base64"), authTag: enc.authTag.toString("base64") } });
  return { mediaId: up.media.mediaId, key, plaintext: pt, ciphertext: enc.ciphertext, encryption: { iv: enc.iv.toString("base64"), authTag: enc.authTag.toString("base64") } };
}

export function countEvents(list, type) {
  return list.filter((e) => e.type === type).length;
}

export { decryptMedia, generateMediaKey, encryptMedia, mediaKeyFingerprint, sha256 };
