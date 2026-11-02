/**
 * @module media/providers/filesystemStorageProvider
 *
 * Filesystem storage provider for storing opaque ciphertext blobs on disk.
 */

import fs from "node:fs/promises";
import path from "node:path";

export function createFilesystemStorageProvider({ baseDir }) {
  const root = baseDir;

  const ensureDir = async () => {
    try {
      await fs.mkdir(root, { recursive: true });
    } catch {
      // directory exists or will fail on write
    }
  };

  const filePath = (mediaId) => {
    const safeId = String(mediaId).replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(root, `${safeId}.bin`);
  };

  return {
    async store(mediaId, blob) {
      await ensureDir();
      const fp = filePath(mediaId);
      const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
      await fs.writeFile(fp, buffer);
      return { mediaId: String(mediaId), size: buffer.length, path: fp };
    },

    async retrieve(mediaId) {
      try {
        const fp = filePath(mediaId);
        return await fs.readFile(fp);
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },

    async delete(mediaId) {
      try {
        const fp = filePath(mediaId);
        await fs.unlink(fp);
        return true;
      } catch (err) {
        if (err.code === "ENOENT") return false;
        throw err;
      }
    },

    async has(mediaId) {
      try {
        const fp = filePath(mediaId);
        await fs.access(fp);
        return true;
      } catch {
        return false;
      }
    },
  };
}
