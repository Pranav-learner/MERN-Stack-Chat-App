# MEDIA PLATFORM AUDIT
**Audit Date:** November 2026  
**Scope:** Secure Media Pipeline, Chunked Delivery, Streaming, Storage Providers, Cloudinary Integration

---

## 1. Media Architecture Overview (Layer 11)

| Subsystem | Intended Role | Implementation Location | Verified Status |
| :--- | :--- | :--- | :--- |
| **Media Pipeline (Sprint 1)** | Device-side E2EE encryption, storage provider, integrity check | `server/media/` | **CRITICAL: MISSING FROM REPOSITORY** |
| **Media Delivery (Sprint 2)** | Chunked transfer, streaming, progressive previews | [`server/media-delivery/`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/media-delivery/) | 3 test suites failing due to missing Sprint 1 |
| **Media Reliability (Sprint 3)** | Checkpoint recovery, stall monitoring | [`server/media-reliability/`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/media-reliability/) | Tests passing with mock dependencies |
| **Legacy Chat Media** | Base64 upload to Cloudinary CDN | [`server/controllers/messageController.js`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/messageController.js) | Functional for UI, but unencrypted |

---

## 2. Missing Codebase Investigation: `server/media/`

The most severe architectural defect discovered during the repository audit is the complete omission of the Layer 11 Sprint 1 codebase:

1. **Broken Imports:**
   - [`server/controllers/mediaController.js:L21-L26`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/mediaController.js#L21-L26) imports:
     ```javascript
     import { MediaManager } from "../media/manager/mediaManager.js";
     import { createMediaApi } from "../media/api/mediaApi.js";
     import { createMongoMediaRepository } from "../media/repository/mongoMediaRepository.js";
     import { createFilesystemStorageProvider } from "../media/providers/filesystemStorageProvider.js";
     import { MediaEventBus } from "../media/events/events.js";
     import { MediaError } from "../media/errors.js";
     ```
   - None of these files exist in the repository.
2. **Impact on Production Runtime:**
   - If `node server.js` is executed in a standard environment, Express crashes immediately upon evaluating `mediaRouter` in [`server/server.js:L333`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/server.js#L333).
3. **Impact on Automated Tests:**
   - 3 test suites in `server/media-delivery/tests/` fail immediately with `ERR_MODULE_NOT_FOUND`.

---

## 3. Cloudinary Integration in UI

In [`server/controllers/messageController.js:L65`](file:///home/pranav/Documents/MERN-Stack-Chat-App/server/controllers/messageController.js#L65):
```javascript
if (image) {
  const uploadResponse = await cloudinary.uploader.upload(image);
  imageUrl = uploadResponse.secure_url;
}
```
- **Security Assessment:** Images sent in chat are uploaded directly to a third-party Cloudinary account in the clear. Cloudinary holds the unencrypted media, violating the zero-knowledge / blind relay security premise.
- **Reliability Assessment:** Uploading large base64 image strings inside HTTP POST bodies risks timeout on slow connections and increases memory consumption on the server.

---

## 4. Key Findings

- **FINDING-MED-01 (Critical):** Missing `server/media/` directory breaks `/api/media` and causes test failures.
- **FINDING-MED-02 (High):** Cloudinary third-party exposure. Images are uploaded unencrypted to an external cloud provider.
