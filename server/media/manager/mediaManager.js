/**
 * @module media/manager/mediaManager
 *
 * MediaManager — the lifecycle orchestrator for the Layer 11 Secure Media Platform.
 * Manages encrypted media uploads, downloads, integrity checks, and pluggable storage providers.
 */

import crypto from "node:crypto";
import {
  MediaError,
  MediaNotFoundError,
  MediaValidationError,
  MediaIntegrityError,
  MediaOperationNotFoundError,
  MediaAuthorizationError,
} from "../errors.js";
import { sha256 } from "../encryption/mediaEncryption.js";
import { MediaEventBus, MediaEventType } from "../events/events.js";

export class MediaManager {
  /**
   * @param {object} deps
   * @param {object} deps.mediaRepo
   * @param {object} [deps.operationRepo]
   * @param {object} [deps.integrityRepo]
   * @param {object} deps.storageProvider
   * @param {MediaEventBus} [deps.events]
   * @param {() => number} [deps.clock]
   */
  constructor(deps = {}) {
    if (!deps.storageProvider) {
      throw new Error("MediaManager requires a storageProvider");
    }
    this.mediaRepo = deps.mediaRepo;
    this.operationRepo = deps.operationRepo;
    this.integrityRepo = deps.integrityRepo;
    this.storageProvider = deps.storageProvider;
    this.events = deps.events ?? new MediaEventBus();
    this.clock = deps.clock ?? (() => Date.now());
  }

  async uploadMedia(params = {}) {
    const {
      mediaId = crypto.randomUUID(),
      ownerId = "anonymous",
      conversationId,
      groupId,
      filename = "file.bin",
      contentType = "application/octet-stream",
      ciphertext,
      plaintextHash,
      plaintextSize = 0,
      encryption,
    } = params;

    if (!ciphertext) throw new MediaValidationError("Missing required ciphertext blob");
    if (!plaintextHash) throw new MediaValidationError("Missing required plaintextHash");
    if (!encryption || !encryption.iv || !encryption.authTag) {
      throw new MediaValidationError("Missing required encryption metadata (iv, authTag)");
    }

    const cipherBuf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext, "base64");
    const ciphertextHash = sha256(cipherBuf);

    await this.storageProvider.store(mediaId, cipherBuf);

    const mediaDoc = {
      mediaId: String(mediaId),
      ownerId: String(ownerId),
      conversationId: conversationId ? String(conversationId) : undefined,
      groupId: groupId ? String(groupId) : undefined,
      filename,
      contentType,
      size: cipherBuf.length,
      plaintextSize: Number(plaintextSize || cipherBuf.length),
      plaintextHash: String(plaintextHash),
      ciphertextHash,
      ciphertextSize: cipherBuf.length,
      encryption: {
        keyFingerprint: String(encryption.keyFingerprint ?? ""),
        iv: String(encryption.iv),
        authTag: String(encryption.authTag),
      },
      state: "available",
      createdAt: this.clock(),
      updatedAt: this.clock(),
    };

    const media = this.mediaRepo ? await this.mediaRepo.create(mediaDoc) : mediaDoc;

    const opDoc = {
      operationId: crypto.randomUUID(),
      mediaId: media.mediaId,
      type: "upload",
      state: "completed",
      bytesTransferred: cipherBuf.length,
      totalBytes: cipherBuf.length,
      createdAt: this.clock(),
    };

    const operation = this.operationRepo ? await this.operationRepo.create(opDoc) : opDoc;

    this.events.emit(MediaEventType.MEDIA_UPLOADED, { mediaId: media.mediaId, ownerId: media.ownerId });
    return { media, operation };
  }

  async downloadMedia({ mediaId, actorId } = {}) {
    if (!mediaId) throw new MediaValidationError("mediaId is required");
    const media = this.mediaRepo ? await this.mediaRepo.findById(mediaId) : null;
    if (!media || media.state === "deleted") {
      throw new MediaNotFoundError(`Media ${mediaId} not found`);
    }

    const blob = await this.storageProvider.retrieve(mediaId);
    if (!blob) throw new MediaNotFoundError(`Ciphertext for media ${mediaId} not found in storage`);

    this.events.emit(MediaEventType.MEDIA_DOWNLOADED, { mediaId, actorId });

    return {
      mediaId: media.mediaId,
      ciphertext: Buffer.isBuffer(blob) ? blob.toString("base64") : blob,
      encryption: media.encryption,
      filename: media.filename,
      contentType: media.contentType,
      plaintextSize: media.plaintextSize,
      plaintextHash: media.plaintextHash,
    };
  }

  async getMetadata({ mediaId, actorId } = {}) {
    if (!mediaId) throw new MediaValidationError("mediaId is required");
    const media = this.mediaRepo ? await this.mediaRepo.findById(mediaId) : null;
    if (!media || media.state === "deleted") {
      throw new MediaNotFoundError(`Media ${mediaId} not found`);
    }
    return media;
  }

  async deleteMedia({ mediaId, actorId } = {}) {
    if (!mediaId) throw new MediaValidationError("mediaId is required");
    const media = await this.getMetadata({ mediaId, actorId });
    if (actorId && media.ownerId && media.ownerId !== actorId) {
      throw new MediaAuthorizationError("Not authorized to delete this media");
    }

    const updated = this.mediaRepo ? await this.mediaRepo.update(mediaId, { state: "deleted" }) : { ...media, state: "deleted" };
    await this.storageProvider.delete(mediaId);
    this.events.emit(MediaEventType.MEDIA_DELETED, { mediaId, actorId });
    return updated;
  }

  async cancelUpload({ operationId, actorId } = {}) {
    if (!operationId) throw new MediaValidationError("operationId is required");
    const op = this.operationRepo ? await this.operationRepo.findById(operationId) : null;
    if (!op) throw new MediaOperationNotFoundError(`Operation ${operationId} not found`);
    const updated = this.operationRepo ? await this.operationRepo.update(operationId, { state: "cancelled" }) : { ...op, state: "cancelled" };
    this.events.emit(MediaEventType.OPERATION_CANCELLED, { operationId, actorId });
    return updated;
  }

  async cancelDownload({ operationId, actorId } = {}) {
    return this.cancelUpload({ operationId, actorId });
  }

  async retryUpload({ operationId, ciphertext, actorId } = {}) {
    if (!operationId) throw new MediaValidationError("operationId is required");
    const op = this.operationRepo ? await this.operationRepo.findById(operationId) : null;
    if (!op) throw new MediaOperationNotFoundError(`Operation ${operationId} not found`);
    const updated = this.operationRepo ? await this.operationRepo.update(operationId, { state: "completed" }) : { ...op, state: "completed" };
    return { operation: updated, retried: true };
  }

  async retryDownload({ operationId, actorId } = {}) {
    if (!operationId) throw new MediaValidationError("operationId is required");
    const op = this.operationRepo ? await this.operationRepo.findById(operationId) : null;
    if (!op) throw new MediaOperationNotFoundError(`Operation ${operationId} not found`);
    return this.downloadMedia({ mediaId: op.mediaId, actorId });
  }

  async listMedia({ ownerId, state = "available", limit = 50 } = {}) {
    if (!this.mediaRepo) return [];
    return this.mediaRepo.list({ ownerId, state, limit });
  }

  async verifyMedia({ mediaId, actorId } = {}) {
    const media = await this.getMetadata({ mediaId, actorId });
    const blob = await this.storageProvider.retrieve(mediaId);
    if (!blob) throw new MediaIntegrityError(`Storage blob missing for media ${mediaId}`);
    const actualHash = sha256(blob);
    if (media.ciphertextHash && actualHash !== media.ciphertextHash) {
      throw new MediaIntegrityError(`Ciphertext integrity hash mismatch for media ${mediaId}`);
    }

    const report = {
      mediaId,
      valid: true,
      verifiedAt: this.clock(),
      size: blob.length,
      ciphertextHash: actualHash,
    };

    if (this.integrityRepo) {
      await this.integrityRepo.create(report);
    }
    this.events.emit(MediaEventType.MEDIA_VERIFIED, report);
    return report;
  }

  async getOperation({ operationId } = {}) {
    if (!operationId) throw new MediaValidationError("operationId is required");
    const op = this.operationRepo ? await this.operationRepo.findById(operationId) : null;
    if (!op) throw new MediaOperationNotFoundError(`Operation ${operationId} not found`);
    return op;
  }

  async getOperations({ mediaId, type } = {}) {
    if (!this.operationRepo) return [];
    return this.operationRepo.list({ mediaId, type });
  }

  async getDiagnostics({ mediaId } = {}) {
    const hasBlob = await this.storageProvider.has(mediaId);
    const media = this.mediaRepo ? await this.mediaRepo.findById(mediaId) : null;
    return {
      mediaId,
      healthy: hasBlob && !!media,
      storageStatus: hasBlob ? "blob-present" : "blob-missing",
      metadataStatus: media ? "metadata-present" : "metadata-missing",
      timestamp: this.clock(),
    };
  }

  async health() {
    const mediaCount = this.mediaRepo ? await this.mediaRepo.count() : 0;
    const opCount = this.operationRepo ? await this.operationRepo.count() : 0;
    return {
      status: "healthy",
      ready: true,
      mediaCount,
      operationsCount: opCount,
      timestamp: this.clock(),
    };
  }
}
