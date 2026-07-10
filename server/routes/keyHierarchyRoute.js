/**
 * @module routes/keyHierarchyRoute
 *
 * Key Hierarchy API routes (Layer 5, Sprint 4), mounted at `/api/key-hierarchy`. Every route
 * is protected by the EXISTING `protectedRoute` JWT middleware and enforces session
 * participation.
 *
 * These endpoints expose the hierarchy's METADATA — root-key + chain ids / fingerprints /
 * generations / indexes. They NEVER accept or return a root key, chain key, or shared secret
 * — the key material is device-local. Static paths precede the `/:sessionId` param route.
 */

import express from "express";
import { protectedRoute } from "../middleware/authmiddleware.js";
import {
  getHierarchy,
  getStatus,
  getChains,
  getRootKey,
  getAudit,
} from "../controllers/keyHierarchyController.js";

const keyHierarchyRouter = express.Router();

keyHierarchyRouter.get("/:sessionId/status", protectedRoute, getStatus);
keyHierarchyRouter.get("/:sessionId/chains", protectedRoute, getChains);
keyHierarchyRouter.get("/:sessionId/root", protectedRoute, getRootKey);
keyHierarchyRouter.get("/:sessionId/audit", protectedRoute, getAudit);
keyHierarchyRouter.get("/:sessionId", protectedRoute, getHierarchy);

export default keyHierarchyRouter;
