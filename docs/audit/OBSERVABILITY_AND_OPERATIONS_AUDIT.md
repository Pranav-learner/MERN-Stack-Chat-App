# OBSERVABILITY AND OPERATIONS AUDIT
**Audit Date:** November 2026  
**Scope:** Health Probes, Prometheus Metrics, Diagnostics, Structured Logging, Operational Endpoints

---

## 1. Operational Endpoints Inventory

| Endpoint | Target Subsystem | Authentication | Response Payload | Assessment |
| :--- | :--- | :--- | :--- | :--- |
| `GET /api/status` | Process root | Public | Text: `"Server is live"` | Lightweight liveness check |
| `GET /api/fabric-reliability/live` | Fabric Reliability | `protectedRoute` | `{ alive: true, uptime, memory }` | Standard container liveness |
| `GET /api/fabric-reliability/ready`| Fabric Reliability | `protectedRoute` | `{ ready: true, subsystemsReady }` | Verifies subsystems initialized |
| `GET /api/fabric-reliability/health`| Fabric Reliability | `protectedRoute` | Health status across all 12 layers | Aggregated health snapshot |
| `GET /api/fabric-reliability/diagnostics` | Diagnostics | `protectedRoute` | Circuit breaker & bulkhead stats | No secret or PII exposure |
| `GET /api/fabric-reliability/metrics`| Metrics Registry | `protectedRoute` | Prometheus text / JSON counters | Request counts, error rates |
| `GET /api/fabric-reliability/freeze` | Protocol Freeze | `protectedRoute` | Protocol v1.0.0 manifest | Static frozen metadata |

---

## 2. Secrets & Information Disclosure Inspection

1. **Diagnostic Payload Verification:**
   Inspection of [`server/fabric-reliability/diagnostics/diagnostics.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/fabric-reliability/diagnostics/diagnostics.js) confirms that responses return numeric counters, latency percentiles, and state machine enums. No cryptographic keys, plaintext message snippets, passwords, or JWT tokens are serialized.
2. **Error Handling & Stack Traces:**
   Legacy controllers catch exceptions and log to `console.error()`, returning `{ success: false, message: "Internal Server Error" }`. Raw database error objects and stack traces are suppressed from client responses.

---

## 3. Operational Monitoring Gaps

1. **Prometheus Scraping Auth Boundary:**
   The metrics endpoint `/api/fabric-reliability/metrics` is behind `protectedRoute` (JWT auth). External Prometheus scrapers (like Kubernetes prometheus-operator or Grafana Cloud agent) typically scrape via an unauthenticated or bearer-token scrape port, which is not configured.
2. **Missing Distributed Tracing Collector:**
   While Layer 12 provides OpenTelemetry-compatible tracing hooks, no OTel collector daemon or Jaeger exporter endpoint is configured in environment variables.

---

## 4. Key Findings

- **FINDING-OBS-01 (Medium):** Authenticated Metrics Endpoint blocks standard Prometheus collectors without custom scrape credentials.
- **FINDING-OBS-02 (Low):** Unstructured root logging. The main Express routes use raw `console.log` rather than a structured JSON logger (e.g. Pino or Winston).
