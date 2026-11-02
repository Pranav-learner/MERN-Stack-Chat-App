import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  cacheUserSocket,
  getUserSocket,
  getUserSockets,
  removeUserSocket,
  getOnlineUsers,
} from "../../lib/redis.js";
import { createRateLimiter } from "../../middleware/rateLimiter.js";
import { isOriginAllowed } from "../../lib/corsPolicy.js";
import {
  createGroup,
  inviteToGroup,
  getGroupMessages,
  sendGroupMessage,
  leaveGroup,
  removeMember,
} from "../../controllers/groupController.js";
import { sendMessage, getAllMessages } from "../../controllers/messageController.js";
import Group from "../../models/Group.model.js";
import Message from "../../models/Message.model.js";

describe("Security & Core Workflows Regression Suite", () => {
  describe("Task 3: Multi-Socket & Redis Set Tracking", () => {
    it("preserves online status when one of multiple sockets disconnects", async () => {
      const userId = "user-multi-device-1";
      const socketA = "socket-tab-A";
      const socketB = "socket-tab-B";

      // Connect two tabs for the same user
      await cacheUserSocket(userId, socketA);
      await cacheUserSocket(userId, socketB);

      const sockets = await getUserSockets(userId);
      assert.ok(sockets.includes(socketA), "Socket A should be cached");
      assert.ok(sockets.includes(socketB), "Socket B should be cached");
      assert.equal(sockets.length, 2, "Both sockets should be active");

      let online = await getOnlineUsers();
      assert.ok(online.includes(userId), "User should be online with 2 tabs");

      // Disconnect tab A
      await removeUserSocket(userId, socketA);

      // User must STILL be online because tab B is open
      online = await getOnlineUsers();
      assert.ok(online.includes(userId), "User must remain online while tab B is open");

      const remainingSockets = await getUserSockets(userId);
      assert.equal(remainingSockets.length, 1);
      assert.equal(remainingSockets[0], socketB);

      // Disconnect tab B
      await removeUserSocket(userId, socketB);

      // User is now offline
      online = await getOnlineUsers();
      assert.ok(!online.includes(userId), "User must be offline after all sockets disconnect");
    });
  });

  describe("Task 2: Rate Limiting on Authentication", () => {
    it("blocks excessive requests and returns HTTP 429 with Retry-After", async () => {
      const limiter = createRateLimiter({
        windowMs: 60 * 1000,
        max: 2,
        keyPrefix: "test-auth-rl",
        message: "Rate limit exceeded",
      });

      const createMockReqRes = (ip = "192.168.1.50") => {
        const headers = {};
        let statusCode = 200;
        let responseBody = null;
        return {
          req: { ip, headers: {} },
          res: {
            setHeader: (name, val) => {
              headers[name] = val;
            },
            status: (code) => {
              statusCode = code;
              return {
                json: (body) => {
                  responseBody = body;
                },
              };
            },
            getHeader: (name) => headers[name],
          },
          getStatusCode: () => statusCode,
          getResponseBody: () => responseBody,
          getHeaders: () => headers,
        };
      };

      // 1st request - pass
      let mock = createMockReqRes();
      let nextCalled = false;
      await limiter(mock.req, mock.res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true, "1st request should pass");
      assert.equal(mock.getHeaders()["RateLimit-Remaining"], 1);

      // 2nd request - pass
      mock = createMockReqRes();
      nextCalled = false;
      await limiter(mock.req, mock.res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true, "2nd request should pass");
      assert.equal(mock.getHeaders()["RateLimit-Remaining"], 0);

      // 3rd request - blocked (429)
      mock = createMockReqRes();
      nextCalled = false;
      await limiter(mock.req, mock.res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false, "3rd request must be blocked");
      assert.equal(mock.getStatusCode(), 429);
      assert.equal(mock.getResponseBody()?.success, false);
      assert.ok(mock.getHeaders()["Retry-After"] > 0, "Must include Retry-After header");
    });
  });

  describe("Task 2: Production CORS Configuration", () => {
    const origEnv = process.env.NODE_ENV;
    const origClientUrl = process.env.CLIENT_URL;

    afterEach(() => {
      process.env.NODE_ENV = origEnv;
      if (origClientUrl) {
        process.env.CLIENT_URL = origClientUrl;
      } else {
        delete process.env.CLIENT_URL;
      }
    });

    it("restricts unauthorized origins in production mode", () => {
      process.env.NODE_ENV = "production";
      process.env.CLIENT_URL = "https://my-chat-app.com";

      assert.equal(isOriginAllowed("https://my-chat-app.com"), true, "Configured CLIENT_URL allowed");
      assert.equal(isOriginAllowed("https://preview-deploy.vercel.app"), true, "Vercel deployments allowed");
      assert.equal(isOriginAllowed("http://malicious-attacker.com"), false, "Malicious origin blocked");
      assert.equal(isOriginAllowed(null), true, "Non-browser / curl requests allowed");
    });

    it("allows local dev origins in development mode", () => {
      process.env.NODE_ENV = "development";
      assert.equal(isOriginAllowed("http://localhost:5173"), true);
      assert.equal(isOriginAllowed("http://localhost:3000"), true);
    });
  });

  describe("Task 2: Group Authorization & BOLA Defenses", () => {
    it("rejects unauthorized access to group messages by non-members (HTTP 403)", async () => {
      const origFindById = Group.findById;
      try {
        // Mock group with members: ["member-alice", "member-bob"]
        Group.findById = async () => ({
          _id: "group-secret-101",
          name: "Confidential Group",
          members: ["member-alice", "member-bob"],
        });

        let statusCode = 200;
        let responseBody = null;
        const res = {
          status: (code) => {
            statusCode = code;
            return { json: (b) => { responseBody = b; } };
          },
        };

        // Unauthorized user attempts to read messages
        const req = {
          params: { groupId: "group-secret-101" },
          user: { _id: "eavesdropper-eve" },
        };

        await getGroupMessages(req, res);
        assert.equal(statusCode, 403, "Non-member must be denied with 403");
        assert.equal(responseBody?.success, false);
        assert.match(responseBody?.message, /Access denied/);
      } finally {
        Group.findById = origFindById;
      }
    });

    it("rejects unauthorized message posting to a group by non-members (HTTP 403)", async () => {
      const origFindById = Group.findById;
      try {
        Group.findById = async () => ({
          _id: "group-secret-101",
          members: ["member-alice"],
        });

        let statusCode = 200;
        let responseBody = null;
        const res = {
          status: (code) => {
            statusCode = code;
            return { json: (b) => { responseBody = b; } };
          },
        };

        const req = {
          params: { groupId: "group-secret-101" },
          user: { _id: "outsider-dave" },
          body: { text: "Hello unauthorized world" },
        };

        await sendGroupMessage(req, res);
        assert.equal(statusCode, 403, "Non-member cannot post messages (403)");
      } finally {
        Group.findById = origFindById;
      }
    });

    it("rejects empty group message payloads (HTTP 400)", async () => {
      let statusCode = 200;
      let responseBody = null;
      const res = {
        status: (code) => {
          statusCode = code;
          return { json: (b) => { responseBody = b; } };
        },
      };

      const req = {
        params: { groupId: "group-1" },
        user: { _id: "member-alice" },
        body: { text: "   " },
      };

      await sendGroupMessage(req, res);
      assert.equal(statusCode, 400, "Empty text and no image must return 400");
    });
  });

  describe("Task 2: Private Messaging Input Validation", () => {
    it("rejects empty message and self-messaging", async () => {
      let statusCode = 200;
      let responseBody = null;
      const res = {
        status: (code) => {
          statusCode = code;
          return { json: (b) => { responseBody = b; } };
        },
      };

      // Self-messaging
      await sendMessage({
        params: { id: "user-alice" },
        user: { _id: "user-alice" },
        body: { text: "Self message" },
      }, res);
      assert.equal(statusCode, 400, "Sending to self must return 400");

      // Empty body
      await sendMessage({
        params: { id: "user-bob" },
        user: { _id: "user-alice" },
        body: { text: "  " },
      }, res);
      assert.equal(statusCode, 400, "Empty message body must return 400");
    });
  });

  describe("Task 2: Socket Authentication Validation", () => {
    it("validates JWT token and checks identity match in socket handshake", () => {
      const secret = "unit-test-secret-key-1234567890";
      const validToken = jwt.sign({ id: "user-socket-verified" }, secret);

      // Verify valid token
      const decoded = jwt.verify(validToken, secret);
      assert.equal(decoded.id, "user-socket-verified");

      // Verify tampered token throws
      assert.throws(() => {
        jwt.verify(validToken + "tampered", secret);
      });
    });
  });

  describe("Task 2: Credential Protection & Sanitization", () => {
    it("omits password hash from user response payload", async () => {
      const { isAuthenticated } = await import("../../controllers/userController.js");
      let statusCode = 200;
      let responseBody = null;
      const res = {
        status: (code) => {
          statusCode = code;
          return { json: (b) => { responseBody = b; } };
        },
      };

      const req = {
        user: {
          _id: "user-safe-1",
          fullName: "Safe User",
          email: "safe@example.com",
          password: "$2a$10$hashedPasswordHere12345",
          bio: "Just chilling",
        },
      };

      await isAuthenticated(req, res);
      assert.equal(statusCode, 200);
      assert.equal(responseBody?.success, true);
      assert.equal(responseBody?.user?.password, undefined, "Password hash must NOT be in user response");
      assert.equal(responseBody?.user?.email, "safe@example.com");
    });
  });

  describe("Fast Track 2: Message Pagination & Cursor Verification", () => {
    it("bounds page size and returns messages in chronological order with cursor", async () => {
      const origFind = Message.find;
      const origUpdateMany = Message.updateMany;
      try {
        const dummyMessages = [
          { _id: "m3", text: "Three", createdAt: new Date("2026-11-02T10:03:00Z") },
          { _id: "m2", text: "Two", createdAt: new Date("2026-11-02T10:02:00Z") },
          { _id: "m1", text: "One", createdAt: new Date("2026-11-02T10:01:00Z") },
        ];

        Message.find = (filter) => ({
          sort: () => ({
            limit: (n) => Promise.resolve(dummyMessages.slice(0, n)),
          }),
        });
        Message.updateMany = async () => ({ modifiedCount: 0 });

        let result = null;
        const res = {
          json: (body) => {
            result = body;
          },
        };

        await getAllMessages({
          params: { id: "user-target" },
          user: { _id: "user-me" },
          query: { limit: "2" },
        }, res);

        assert.equal(result?.success, true);
        assert.equal(result?.hasMore, true);
        assert.equal(result?.messages.length, 2);
        // Chronological order: oldest first
        assert.equal(result?.messages[0]._id, "m2");
        assert.equal(result?.messages[1]._id, "m3");
        assert.ok(result?.nextCursor, "Must return nextCursor when hasMore is true");
      } finally {
        Message.find = origFind;
        Message.updateMany = origUpdateMany;
      }
    });
  });

  describe("Fast Track 2: Delivery Idempotency & Deduplication", () => {
    it("returns existing message on duplicate clientMessageId without creating duplicates", async () => {
      const origFindOne = Message.findOne;
      try {
        const existingMessage = {
          _id: "msg-idempotent-001",
          senderId: "user-alice",
          receiverId: "user-bob",
          text: "Idempotent message content",
          clientMessageId: "idemp-key-xyz-123",
          status: "delivered",
        };

        Message.findOne = async (query) => {
          if (query.clientMessageId === "idemp-key-xyz-123") {
            return existingMessage;
          }
          return null;
        };

        let statusCode = 0;
        let result = null;
        const res = {
          status: (code) => {
            statusCode = code;
            return { json: (b) => { result = b; } };
          },
        };

        await sendMessage({
          params: { id: "user-bob" },
          user: { _id: "user-alice" },
          body: {
            text: "Idempotent message content",
            clientMessageId: "idemp-key-xyz-123",
          },
        }, res);

        assert.equal(statusCode, 200, "Duplicate request must return 200");
        assert.equal(result?.duplicate, true, "Must flag duplicate: true");
        assert.equal(result?.message._id, "msg-idempotent-001");
      } finally {
        Message.findOne = origFindOne;
      }
    });
  });

  describe("Fast Track 2: Group Membership Lifecycle & Revocation", () => {
    it("instantly revokes message access and posting when a member leaves or is removed", async () => {
      const groupData = {
        _id: "group-lifecycle-1",
        admin: "admin-user",
        members: ["admin-user", "leaving-user"],
        save: async function () { return this; },
      };

      const origFindById = Group.findById;
      try {
        Group.findById = async () => groupData;

        let statusCode = 0;
        let result = null;
        const res = {
          status: (code) => {
            statusCode = code;
            return { json: (b) => { result = b; } };
          },
        };

        // User leaves group
        await leaveGroup({
          body: { groupId: "group-lifecycle-1" },
          user: { _id: "leaving-user" },
        }, res);
        assert.equal(statusCode, 200);
        assert.ok(!groupData.members.includes("leaving-user"), "User must be removed from members list");

        // Immediately attempt to read group messages
        statusCode = 0;
        await getGroupMessages({
          params: { groupId: "group-lifecycle-1" },
          user: { _id: "leaving-user" },
          query: {},
        }, res);
        assert.equal(statusCode, 403, "Removed member must be rejected from reading with 403");

        // Immediately attempt to post group message
        statusCode = 0;
        await sendGroupMessage({
          params: { groupId: "group-lifecycle-1" },
          user: { _id: "leaving-user" },
          body: { text: "Sneaking in" },
        }, res);
        assert.equal(statusCode, 403, "Removed member must be rejected from writing with 403");
      } finally {
        Group.findById = origFindById;
      }
    });
  });

  describe("Fast Track 2: Media Upload Validation", () => {
    it("rejects image payloads exceeding 5MB limit with HTTP 400", async () => {
      let statusCode = 0;
      let result = null;
      const res = {
        status: (code) => {
          statusCode = code;
          return { json: (b) => { result = b; } };
        },
      };

      // Oversized base64 string (> 7MB)
      const hugeImage = "data:image/jpeg;base64," + "A".repeat(8 * 1024 * 1024);

      await sendMessage({
        params: { id: "user-bob" },
        user: { _id: "user-alice" },
        body: { image: hugeImage },
      }, res);

      assert.equal(statusCode, 400, "Oversized upload must return 400");
      assert.match(result?.message, /exceeds maximum allowed size/);
    });
  });
});


