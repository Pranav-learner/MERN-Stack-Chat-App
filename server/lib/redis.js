import Redis from "ioredis";

// Use UPSTASH_REDIS_REST_URL if provided, else fallback to local.
// Note: ioredis expects a connection string (redis://...)
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

redis.on("connect", () => {
  console.log("Redis connected successfully");
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err);
});

// Helper functions for User Socket Management

export const cacheUserSocket = async (userId, socketId) => {
  await redis.set(`user:${userId}`, socketId);
};

export const getUserSocket = async (userId) => {
  return await redis.get(`user:${userId}`);
};

export const removeUserSocket = async (userId) => {
  await redis.del(`user:${userId}`);
};

export const getOnlineUsers = async () => {
  const keys = await redis.keys("user:*");
  return keys.map((key) => key.split(":")[1]);
};

export default redis;
