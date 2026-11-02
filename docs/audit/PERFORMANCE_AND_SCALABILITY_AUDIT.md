# PERFORMANCE AND SCALABILITY AUDIT
**Audit Date:** November 2026  
**Scope:** Concurrency Bottlenecks, Query Patterns, Memory Footprint, Demo Resource Limits

---

## 1. Concurrency & Performance Bottlenecks

### 1. Unbounded Message History Queries (Missing Pagination)
- **Location:** [`server/controllers/messageController.js:L30`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/messageController.js#L30) and [`groupController.js:L163`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/groupController.js#L163)
- **Pattern:**
  ```javascript
  const messages = await Message.find({ $or: [...] });
  res.status(200).json({ success: true, messages });
  ```
- **Risk:** There is no `limit()` or cursor pagination. As conversations grow beyond a few hundred messages, opening a chat loads all historical messages into memory, degrading backend response times and client DOM rendering.

### 2. Redis Key Space Scanning on Socket Events
- **Location:** [`server/lib/redis.js:L30`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/lib/redis.js#L30)
- **Pattern:** `redis.keys("user:*")` executed on every connect and disconnect.
- **Risk:** $O(N)$ linear blocking overhead on Redis.

### 3. Base64 JSON Media Overhead
- **Location:** [`server/controllers/messageController.js:L65`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/messageController.js#L65)
- **Pattern:** Images are read as base64 data URLs in the browser and transmitted inside a JSON payload to `POST /api/messages/send`.
- **Risk:** Base64 increases byte payload size by ~33% and causes V8 string allocation spikes on the server during JSON parsing.

---

## 2. Resource Sizing Recommendations for Live Demonstrations

For an interviewer live demo or portfolio showcase:

| Resource Dimension | Minimum Recommended | Standard Cloud Tier |
| :--- | :--- | :--- |
| **Backend CPU / RAM** | 0.5 vCPU, 512 MB RAM | Render Free Web Service / Railway Starter |
| **Database Tier** | Shared Cluster (512 MB Storage) | MongoDB Atlas M0 (Free) |
| **Redis Instance** | 10,000 commands/day | Upstash Redis Free Tier |
| **Max Concurrent Users** | 20–50 simultaneous users | Ample for portfolio reviewers |

---

## 3. Key Findings

- **FINDING-PERF-01 (High):** Missing pagination on `/api/messages/:id` leads to unbounded memory consumption on large chat histories.
- **FINDING-PERF-02 (Medium):** Base64 payload transfer causes unnecessary memory inflation compared to multipart form uploads.
