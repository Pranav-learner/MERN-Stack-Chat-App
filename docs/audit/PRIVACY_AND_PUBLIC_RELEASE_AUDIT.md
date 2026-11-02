# PRIVACY AND PUBLIC RELEASE AUDIT
**Audit Date:** November 2026  
**Scope:** Privacy Policy, Account Deletion, Third-Party Disclosures, Security Claims vs. Reality

---

## 1. Regulatory & Privacy Posture

| Requirement | Implementation Status | Risk Assessment |
| :--- | :--- | :--- |
| **Privacy Policy** | **Missing** | High risk if deployed publicly for real users; acceptable for private portfolio showcase |
| **Terms of Service** | **Missing** | High risk for public SaaS; acceptable for portfolio showcase |
| **Account Deletion (Right to be Forgotten)** | **Not Implemented** | No self-service endpoint exists for users to delete their account and data |
| **Data Retention Policy** | **Indefinite** | Messages and user profiles persist in MongoDB indefinitely with no TTL expiration |
| **Third-Party Disclosures** | **Missing** | Unencrypted photos transmitted to Cloudinary without user notification or disclosure |

---

## 2. Public Claims vs. Technical Reality

To maintain professional credibility during technical interviews and portfolio reviews, public claims must accurately reflect the implementation:

| Documentation Claim | Technical Reality | Recommended Interview Presentation |
| :--- | :--- | :--- |
| *"End-to-end encrypted messaging"* | The React UI sends cleartext; E2EE is implemented in the Layer 4-12 SDK / test suites | *"The platform features a modular 12-layer cryptographic engine with ratchet-based E2EE; the current frontend demonstrates the real-time messaging UX over standard channels."* |
| *"The server is a blind relay"* | Legacy routes `/api/messages` store plaintext in MongoDB | *"The Layer 8-11 protocol specifications establish a zero-knowledge blind relay; the legacy MERN endpoints remain active for full-stack compatibility."* |
| *"Fully P2P communication"* | Communication uses Socket.io server relay fallback | *"The architecture includes P2P connection planning and adaptive scoring, backed by a resilient server relay."* |

---

## 3. Key Findings

- **FINDING-PRIV-01 (High):** Public Security Claims Mismatch. Presenting the web application as a fully functioning E2EE messaging platform is factually inaccurate and easily disproved by inspecting network requests in browser DevTools.
- **FINDING-PRIV-02 (Medium):** Absence of User Data Purge / Account Deletion capability.
