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
// and multi-socket per user tracking

export const cacheUserSocket = async (userId, socketId) => {
  const uid = String(userId);
  const sid = String(socketId);

  // In-memory tracking
  if (!memoryUserSockets.has(uid)) {
    memoryUserSockets.set(uid, new Set());
  }
  memoryUserSockets.get(uid).add(sid);

  // Redis tracking
  if (redis && redis.status === "ready") {
    try {
      await redis.sadd(`user_sockets:${uid}`, sid);
      await redis.sadd("online_users", uid);
    } catch {
      // In-memory fallback retains socket mapping
    }
  }
};

export const getUserSockets = async (userId) => {
  const uid = String(userId);
  if (redis && redis.status === "ready") {
    try {
      const sockets = await redis.smembers(`user_sockets:${uid}`);
      if (sockets && sockets.length > 0) return sockets;
    } catch {
      // In-memory fallback
    }
  }
  const set = memoryUserSockets.get(uid);
  return set ? Array.from(set) : [];
};

export const getUserSocket = async (userId) => {
  const sockets = await getUserSockets(userId);
  return sockets.length > 0 ? sockets[0] : null;
};

export const removeUserSocket = async (userId, socketId = null) => {
  const uid = String(userId);

  if (socketId) {
    const sid = String(socketId);
    // Remove specific socket
    const set = memoryUserSockets.get(uid);
    if (set) {
      set.delete(sid);
      if (set.size === 0) {
        memoryUserSockets.delete(uid);
      }
    }

    if (redis && redis.status === "ready") {
      try {
        await redis.srem(`user_sockets:${uid}`, sid);
        const remaining = await redis.scard(`user_sockets:${uid}`);
        if (remaining === 0) {
          await redis.srem("online_users", uid);
        }
      } catch {
        // In-memory fallback
      }
    }
  } else {
    // Remove all sockets for this user
    memoryUserSockets.delete(uid);

    if (redis && redis.status === "ready") {
      try {
        await redis.del(`user_sockets:${uid}`);
        await redis.srem("online_users", uid);
      } catch {
        // In-memory fallback
      }
    }
  }
};

export const getOnlineUsers = async () => {
  if (redis && redis.status === "ready") {
    try {
      const members = await redis.smembers("online_users");
      if (members && members.length > 0) return members;
    } catch {
      // In-memory fallback
    }
  }
  return Array.from(memoryUserSockets.keys());
};

export default redis;


