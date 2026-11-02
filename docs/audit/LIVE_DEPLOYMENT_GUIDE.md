# Production Live Deployment Guide
**Realtime MERN Chat Application + P2P Architecture**

This guide documents the exact configuration, environment variables, hosting architecture, and steps required to deploy the application to public production infrastructure for portfolio demonstrations and technical interviews.

---

## 1. Architectural Runtime Requirements

### Critical Host Compatibility Check
- **Backend: Persistent Node.js Runtime Required.**
  The backend utilizes persistent bidirectional WebSockets (`socket.io`), in-memory socket connection tracking, and periodic background reliability and heartbeat monitors (`stallMonitor`, `heartbeatMonitor`).
  > [!WARNING]
  > **Do NOT deploy the backend as a Serverless Function (e.g. Vercel Serverless / AWS Lambda).** Serverless lambdas freeze or terminate after single HTTP requests, breaking persistent WebSockets, dropping real-time events, and killing background intervals.
  - **Recommended Hosts:** **Render** (Web Service), **Railway**, **Fly.io**, or **AWS EC2 / DigitalOcean Droplet**.
  - **Free Tier Behavior (Render):** Render Web Services on the free tier spin down after 15 minutes of inactivity. When a new request arrives, a cold start takes ~50 seconds before the service is warm. For live interview demos, wake the service 2 minutes prior or upgrade to an unthrottled instance ($7/mo).

- **Frontend: Static Single Page Application (SPA).**
  The frontend is built with React 19 and Vite into static assets (`dist/`).
  - **Recommended Host:** **Vercel**, **Netlify**, or **Cloudflare Pages**.
  - **SPA Rewrites:** Handled via [`client/vercel.json`](file:///home/pranav/Documents/MERN-Stack-Chat-App/client/vercel.json) rewrite rule routing `/(.*)` to `/index.html`.

---

## 2. Environment Variables Specification

All variable names match the actual implementation in source code. Do not invent custom variable names.

### Backend (`server/`)
| Environment Variable | Required? | Source / Location | Description & Constraints |
|---|---|---|---|
| `PORT` | Optional | Set by host | Port for the HTTP/Socket server (default: `5000`, Render defaults to `10000`). |
| `NODE_ENV` | **Yes** | Host Config | Must be set to `production` to activate production CORS guards and error masking. |
| `MONGODB_URI` | **Yes** | MongoDB Atlas | Connection URI (e.g. `mongodb+srv://<user>:<password>@cluster0.mongodb.net/?retryWrites=true&w=majority`). Mongoose attaches `dbName: "chat-app"`. |
| `JWT_SECRET` | **Yes** | Generated Secret | 256-bit random string for signing user session JWTs. Generate with `openssl rand -hex 32`. |
| `CLIENT_URL` | **Yes** | Vercel Deployment | The public HTTPS URL of the deployed frontend (e.g. `https://chatapp-demo.vercel.app`). Trailing slashes are stripped automatically. |
| `FRONTEND_URL` | Optional | Vercel Deployment | Alternative alias for the frontend URL. |
| `REDIS_URL` | Optional | Upstash / Redis Cloud | Redis connection URI (e.g. `rediss://default:<pass>@<host>:<port>`). If omitted or unreachable, backend safely falls back to in-memory `Map`. |
| `CLOUDINARY_CLOUD_NAME` | Optional | Cloudinary Console | Cloudinary cloud identifier for media uploads. |
| `CLOUDINARY_API_KEY` | Optional | Cloudinary Console | Cloudinary API Key. |
| `CLOUDINARY_API_SECRET` | Optional | Cloudinary Console | Cloudinary API Secret. |

### Frontend (`client/`)
| Environment Variable | Required? | Location | Description & Constraints |
|---|---|---|---|
| `VITE_BACKEND_URL` | **Yes** | Vercel Dashboard | The public HTTPS URL of the deployed backend (e.g. `https://mern-chatapp-api.onrender.com`). Trailing slashes are safely normalized. |

---

## 3. Step-by-Step Deployment Procedure

### Phase A: Managed Database Setup (MongoDB Atlas)
1. Log in to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. Create or select a free Shared Cluster (M0).
3. Under **Database Access**, create a user with `Read and write to any database` privileges.
4. Under **Network Access**, add IP `0.0.0.0/0` (Allow Access from Anywhere) so hosted cloud instances can reach the database.
5. In **Database** > **Connect** > **Drivers**, copy the connection string:
   `mongodb+srv://<username>:<password>@cluster0.mongodb.net/?retryWrites=true&w=majority`

### Phase B: Backend Deployment (Render Example)
1. Push your repository to GitHub.
2. Log in to [Render Dashboard](https://dashboard.render.com).
3. Click **New +** > **Web Service**.
4. Connect the GitHub repository `Pranav-learner/MERN-Stack-Chat-App`.
5. Configure the service:
   - **Name:** `chatapp-backend` (or your choice)
   - **Root Directory:** `server`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start` (or `node server.js`)
   - **Instance Type:** `Free`
6. Add Environment Variables:
   - `NODE_ENV`: `production`
   - `MONGODB_URI`: `<your_atlas_connection_string>`
   - `JWT_SECRET`: `<generated_random_secret>`
   - `CLIENT_URL`: `https://<your-frontend-project>.vercel.app` (can update after deploying frontend)
   - `CLOUDINARY_CLOUD_NAME`: `<your_cloud_name>`
   - `CLOUDINARY_API_KEY`: `<your_api_key>`
   - `CLOUDINARY_API_SECRET`: `<your_api_secret>`
7. Under **Health Check Path**, enter: `/health`.
8. Click **Deploy Web Service**.
9. Once deployed, note your public backend URL: `https://chatapp-backend.onrender.com`.
10. Verify health in your browser: `https://chatapp-backend.onrender.com/health` should return HTTP 200 `{ status: "ok", services: { database: "connected" } }`.

### Phase C: Frontend Deployment (Vercel)
1. Log in to [Vercel Dashboard](https://vercel.com).
2. Click **Add New...** > **Project** and import `Pranav-learner/MERN-Stack-Chat-App`.
3. Configure the project:
   - **Framework Preset:** `Vite`
   - **Root Directory:** Click Edit and select `client`.
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
4. Expand **Environment Variables**:
   - Key: `VITE_BACKEND_URL`
   - Value: `https://chatapp-backend.onrender.com` (your actual backend URL from Phase B, without trailing slash)
5. Click **Deploy**.
6. Once deployed, note your public frontend URL: `https://<your-project>.vercel.app`.

### Phase D: Cross-Origin Synchronization
1. Return to your Render Web Service settings for the backend.
2. Ensure `CLIENT_URL` matches your exact Vercel frontend URL: `https://<your-project>.vercel.app`.
3. Save changes (Render will trigger a zero-downtime redeploy).

---

## 4. Verification & Smoke Test Protocol

Once both services are deployed, execute the following verification steps on the live URLs:

1. **Backend Health Check:**
   - Navigate to `https://<backend-url>/health`
   - Verify HTTP 200 `{ "status": "ok", "services": { "database": "connected" } }`.
2. **Frontend Load:**
   - Navigate to `https://<frontend-url>`
   - Verify homepage loads cleanly over HTTPS with demo notification banner.
3. **Authentication:**
   - Register User A (`testuserA@demo.com`). Verify success toast and redirection.
   - Log out. Register User B (`testuserB@demo.com`). Verify separate session.
4. **Real-Time Communication:**
   - Open User A in an incognito window and User B in a normal window side-by-side.
   - User A selects User B. Verify online presence indicator displays green dot.
   - User A sends a message. Verify User B receives it in real-time via Socket.IO without page refresh.
5. **Message Persistence:**
   - Refresh User B's browser. Verify conversation history reloads accurately in chronological order.
6. **Group Messaging:**
   - User A creates a group and invites User B.
   - User B accepts and sends a group message. Verify both members receive the broadcast.
7. **Media Sharing:**
   - Attach an image under 5MB. Send and verify preview renders on both devices.
8. **Security & Limits:**
   - Verify attempting to upload a file > 5MB triggers an immediate client-side toast rejection.
   - Verify unauthenticated requests to `/api/messages/history` return HTTP 401.

---

## 5. Security & Secrets Policy

1. **Zero Secret Exposure:**
   - Never commit `.env` or configuration files with real credentials to GitHub.
   - All production keys must be managed exclusively through the host web consoles (Render Environment Settings, Vercel Project Settings).
2. **Demo Disclaimer:**
   - Because the live interface uses standard server-readable transport encryption (HTTPS/WSS), users should never submit passwords, banking info, or private personal data during portfolio demonstrations.
