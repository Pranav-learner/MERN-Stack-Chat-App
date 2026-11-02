# DEPLOYMENT READINESS AUDIT
**Audit Date:** November 2026  
**Scope:** Build Process, Containerization, Vercel Serverless Compatibility, Interview Demo Hosting

---

## 1. Hosting Architecture Evaluation

### The User's Real-World Objective:
> *"I just want a live site so the interviewer can see this project and use it... so I want to deploy in small things like Vercel as I have already done."*

### Compatibility Breakdown:

| Component | Target Platform | Compatibility Assessment | Issues / Required Changes |
| :--- | :--- | :--- | :--- |
| **Client Frontend** (`client/`) | **Vercel** (Vite SPA) | **100% Compatible** | Deployable immediately. Rewrites in `client/vercel.json` are correct. |
| **Backend Server** (`server/`) | **Vercel Serverless** (`@vercel/node`) | **INCOMPATIBLE** | 1. Persistent Socket.io WebSockets fail on serverless lambdas.<br>2. 7 background interval timers freeze.<br>3. Top-level `server.listen()` conflicts with lambda handler.<br>4. Missing `server/media/` crashes server boot. |
| **Backend Server** (`server/`) | **Render / Railway / Fly.io** | **100% Compatible** | Supports persistent Node.js processes, WebSockets, background sweeps, and Redis connections. |

---

## 2. Why Vercel Serverless Fails for `server.js`

1. **Stateful Socket.io Connection Drops:**
   Vercel serverless functions spin up to handle an HTTP request and spin down immediately after responding. They do not maintain long-lived TCP sockets necessary for real-time Socket.io chat (`io.on("connection")`).
2. **Missing Module Startup Crash:**
   [`server/server.js:L45`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/server.js#L45) imports `mediaRouter`, which imports `mediaController.js`, which imports `../media/manager/mediaManager.js`. Because `server/media/` is missing, deployment builds fail with `ERR_MODULE_NOT_FOUND`.
3. **Background Interval Freezing:**
   The 7 reliability monitors (`heartbeatMonitor`, `stallMonitor`, `syncStallMonitor`, `groupStallMonitor`, `mediaStallMonitor`, `fabricReliabilityStallMonitor`, `reliabilityHeartbeatMonitor`) require a continuous event loop. Serverless execution freezes execution immediately after the HTTP response closes.

---

## 3. Optimal Fast-Track Architecture for Live Interview Demonstrations

To achieve a working live URL for interviewers quickly and at zero cost:

```mermaid
flowchart LR
    Browser["Interviewer Browser"]
    Vercel["Frontend on Vercel\n(React 19 Vite SPA)"]
    Render["Backend on Render.com / Railway\n(Node.js Persistent Web Service)"]
    Atlas[("MongoDB Atlas M0\n(Free Cloud DB)")]
    Upstash[("Upstash Redis\n(Free Cloud Redis)")]
    Cloudinary["Cloudinary CDN\n(Image Hosting)"]

    Browser -->|HTTPS| Vercel
    Vercel -->|WSS / Socket.io| Render
    Vercel -->|REST API| Render
    Render --> Atlas
    Render --> Upstash
    Render --> Cloudinary
```

---

## 4. Mandatory Environment Variables Checklist

| Variable Name | Required By | Description / Example |
| :--- | :--- | :--- |
| `MONGODB_URI` | `server/lib/db.js` | MongoDB connection string (e.g., `mongodb+srv://user:pass@cluster.mongodb.net`) |
| `JWT_SECRET` | `server/lib/utils.js` | Secure 64-character random string for signing session JWTs |
| `PORT` | `server/server.js` | Web service port (defaults to 5000 or assigned by host) |
| `REDIS_URL` | `server/lib/redis.js` | Connection string (e.g., Upstash `rediss://default:token@host:port`) |
| `CLOUDINARY_CLOUD_NAME` | `server/lib/cloudinary.js` | Cloudinary account cloud name |
| `CLOUDINARY_API_KEY` | `server/lib/cloudinary.js` | Cloudinary account API key |
| `CLOUDINARY_API_SECRET`| `server/lib/cloudinary.js` | Cloudinary account API secret |
| `VITE_BACKEND_URL` | `client/context/AuthContext.jsx` | Full URL of the live backend (e.g., `https://chat-backend.onrender.com`) |

---

## 5. Key Findings

- **FINDING-DEP-01 (Critical):** Server crashes on boot due to missing `server/media/` imports.
- **FINDING-DEP-02 (High):** Vercel Serverless incompatibility with stateful Socket.io and background interval monitors.
- **FINDING-DEP-03 (Medium):** Missing dependencies in local environment (`node_modules` not installed).
