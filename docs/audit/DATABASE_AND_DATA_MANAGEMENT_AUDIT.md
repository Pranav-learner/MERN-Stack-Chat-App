# DATABASE AND DATA MANAGEMENT AUDIT
**Audit Date:** November 2026  
**Scope:** MongoDB Schemas, Indexes, Transactions, In-Memory vs. Mongoose Repositories, Redis Usage

---

## 1. Database Connection & Lifecycle

### Connection Management ([`server/lib/db.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/lib/db.js))
```javascript
export const connectDB = async () => {
  try {
    mongoose.connection.on("connected", () => console.log("Database connected"));
    await mongoose.connect(`${process.env.MONGODB_URI}/chat-app`);
  } catch (error) {
    console.log(error);
  }
};
```
- **Top-Level Await Hazard:** In `server.js:L400`, `await connectDB()` is invoked at the module root. If `MONGODB_URI` is undefined, the connection string evaluates to `undefined/chat-app`, throwing an unhandled rejection that can terminate the Node process.
- **Connection Resiliency:** Lacks explicit pool sizing (`maxPoolSize`, `minPoolSize`) and auto-reconnect retry backoff options.

---

## 2. Data Models and Indexes

| Model | File | Primary Fields | Indexes & Constraints | Audit Assessment |
| :--- | :--- | :--- | :--- | :--- |
| **User** | [`models/User.model.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/models/User.model.js) | `email`, `fullName`, `password`, `profilePic`, `bio` | `unique: true` on `email` | Proper unique constraint; password stored hashed |
| **Message** | [`models/Message.model.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/models/Message.model.js) | `senderId`, `receiverId`, `groupId`, `text`, `image`, `status` | Compound index on `{ senderId: 1, receiverId: 1 }` | Query performance good for 1-to-1 chats |
| **Group** | [`models/Group.model.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/models/Group.model.js) | `name`, `admin`, `members`, `invites` | Index on `members` | Clean membership structure |
| **Subsystem Models** | `server/*/models/` | Metadata, Transfers, Replicas, Checkpoints | Varies per layer | Dual in-memory / Mongoose repository pattern |

---

## 3. Redis Presence Performance Risk

In [`server/lib/redis.js:L29-L32`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/lib/redis.js#L29-L32):
```javascript
export const getOnlineUsers = async () => {
  const keys = await redis.keys("user:*");
  return keys.map((key) => key.split(":")[1]);
};
```
### Performance Risk (`FINDING-DB-01`, Severity: High):
- **Blocking $O(N)$ Keys Command:** The `redis.keys()` command scans the entire Redis database keyspace synchronously. On every user socket connection and disconnection (`server.js:L85, L158`), `getOnlineUsers` is called and broadcasts to all clients.
- In a production environment with thousands of keys, this blocks the single-threaded Redis engine, causing latency spikes and connection timeouts.
- **Remediation:** Use a Redis Set (e.g., `SADD online_users userId`, `SREM online_users userId`, `SMEMBERS online_users`) for instantaneous $O(1)$ operations.

---

## 4. Key Findings

- **FINDING-DB-01 (High):** Redis `keys("user:*")` command creates a denial-of-service risk under production concurrency.
- **FINDING-DB-02 (Medium):** Real MongoDB integration was skipped in automated tests (100% in-memory mock testing).
- **FINDING-DB-03 (Medium):** Missing database connection timeout and pooling configuration.
