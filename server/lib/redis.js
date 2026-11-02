import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;
let redis = null;
const memoryUserSockets = new Map();

if (redisUrl) {
  try {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    redis.on("connect", () => console.log("Redis connected successfully"));
    redis.on("error", (err) => console.warn("Redis connection warning:", err.message));
  } catch (err) {
    console.warn("Failed to initialize Redis client:", err.message);
  }
} else {
  try {
    redis = new Redis("redis://localhost:6379", {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    redis.on("connect", () => console.log("Local Redis connected successfully"));
    redis.on("error", () => {
      // In-memory fallback active when local redis is not running
    });
  } catch {
    redis = null;
  }
}

// Helper functions for User Socket Management with resilient in-memory fallback

export const cacheUserSocket = async (userId, socketId) => {
  memoryUserSockets.set(String(userId), String(socketId));
  if (redis && redis.status === "ready") {
    try {
      await redis.set(`user:${userId}`, socketId);
      await redis.sadd("online_users", String(userId));
    } catch {
      // In-memory fallback retains the socket mapping
    }
  }
};

export const getUserSocket = async (userId) => {
  if (redis && redis.status === "ready") {
    try {
      const sock = await redis.get(`user:${userId}`);
      if (sock) return sock;
    } catch {
      // In-memory fallback
    }
  }
  return memoryUserSockets.get(String(userId)) || null;
};

export const removeUserSocket = async (userId) => {
  memoryUserSockets.delete(String(userId));
  if (redis && redis.status === "ready") {
    try {
      await redis.del(`user:${userId}`);
      await redis.srem("online_users", String(userId));
    } catch {
      // In-memory fallback
    }
  }
};

export const getOnlineUsers = async () => {
  if (redis && redis.status === "ready") {
    try {
      const members = await redis.smembers("online_users");
      if (members && members.length > 0) return members;
      const keys = await redis.keys("user:*");
      if (keys.length > 0) return keys.map((key) => key.split(":")[1]);
    } catch {
      // In-memory fallback
    }
  }
  return Array.from(memoryUserSockets.keys());
};

export default redis;

