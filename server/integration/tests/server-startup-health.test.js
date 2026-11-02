import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { connectDB } from "../../lib/db.js";
import { cacheUserSocket, getUserSocket, removeUserSocket, getOnlineUsers } from "../../lib/redis.js";
import { MediaManager, generateMediaKey, encryptMedia, decryptMedia } from "../../media/index.js";

describe("Server Initialization & Health Probes (Regression Suite)", () => {
  it("connectDB returns false and handles missing MONGODB_URI gracefully", async () => {
    const origUri = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    try {
      const result = await connectDB();
      assert.equal(result, false, "Should return false cleanly without crashing on missing URI");
    } finally {
      if (origUri) process.env.MONGODB_URI = origUri;
    }
  });

  it("Redis helpers handle disconnected state using in-memory fallback", async () => {
    const testUserId = "test-user-alpha";
    const testSocketId = "sock-xyz-123";

    await cacheUserSocket(testUserId, testSocketId);
    const retrieved = await getUserSocket(testUserId);
    assert.equal(retrieved, testSocketId, "Retrieved socket id should match cached value in fallback");

    const online = await getOnlineUsers();
    assert.ok(online.includes(testUserId), "User should appear in online list");

    await removeUserSocket(testUserId);
    const afterRemoval = await getUserSocket(testUserId);
    assert.equal(afterRemoval, null, "User socket should be cleared after removal");
  });

  it("All media module exports are accessible and function correctly", () => {
    assert.equal(typeof MediaManager, "function");
    assert.equal(typeof generateMediaKey, "function");
    assert.equal(typeof encryptMedia, "function");
    assert.equal(typeof decryptMedia, "function");

    const key = generateMediaKey();
    assert.equal(key.length, 32);

    const pt = Buffer.from("Verification Payload");
    const enc = encryptMedia(pt, key);
    const dec = decryptMedia(enc, key);
    assert.equal(dec.toString(), pt.toString());
  });
});
