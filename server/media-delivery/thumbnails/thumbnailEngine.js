/**
 * @module media-delivery/thumbnails
 *
 * **Thumbnail engine** — ASYNC, PLUGGABLE thumbnail generation + versioning + a generation history. It
 * does NOT decode images/video itself (no codecs this layer) — a pluggable `generator` hook produces the
 * thumbnail (device-side, or a worker), returning either a small encrypted thumbnail media id (a
 * separately-uploaded Sprint-1 media object) or a metadata-only descriptor. The default generator is a
 * deterministic METADATA-ONLY placeholder (dimensions from the media's resolution placeholder / defaults),
 * so the engine is fully testable without codecs.
 *
 * @security Thumbnail records carry ids + dimensions + a version + an optional encrypted-thumbnail media
 * id ONLY — never plaintext pixels or keys. A generated thumbnail, if produced, is itself encrypted media
 * stored through the Sprint-1 pipeline.
 *
 * @evolution Generation is async + pluggable: a deployment injects a real generator without changing the
 * engine. Pure helpers here; the delivery engine owns persistence + events.
 */

import crypto from "node:crypto";
import { PreviewKind, PreviewState, CONTENT_PREVIEW_KIND, MEDIA_DELIVERY_SCHEMA_VERSION } from "../types/types.js";
import { PreviewError } from "../errors.js";

/** Pick the preview/thumbnail kind for a content type. */
export function kindForContentType(contentType) {
  const ct = String(contentType ?? "");
  for (const { prefix, kind } of CONTENT_PREVIEW_KIND) if (ct.startsWith(prefix)) return kind;
  return PreviewKind.DOCUMENT_PREVIEW;
}

/**
 * Build a preview/thumbnail record (PENDING). @param {object} params
 * @param {string} params.mediaId @param {string} params.kind @param {() => number} [params.clock] @param {() => string} [params.idGenerator]
 */
export function createPreviewRecord(params) {
  const clock = params.clock ?? (() => Date.now());
  const idGenerator = params.idGenerator ?? (() => crypto.randomUUID());
  const nowIso = new Date(clock()).toISOString();
  return {
    previewId: params.previewId ?? idGenerator(),
    mediaId: String(params.mediaId),
    kind: params.kind,
    state: PreviewState.PENDING,
    version: 0,
    metadata: {},
    history: [],
    createdAt: nowIso,
    updatedAt: nowIso,
    schemaVersion: MEDIA_DELIVERY_SCHEMA_VERSION,
  };
}

/**
 * The default METADATA-ONLY generator (no codecs). Deterministic. Emits reasonable dimensions from the
 * media's resolution placeholder or a default. A deployment replaces this with a real device/worker
 * generator (which may also upload an encrypted thumbnail blob and return its media id).
 * @returns {Promise<{ metadata: object }>}
 */
export async function defaultThumbnailGenerator({ media, kind }) {
  const res = media?.resolution ?? {};
  const width = res.width ?? (kind === PreviewKind.VIDEO_THUMBNAIL ? 320 : 256);
  const height = res.height ?? (kind === PreviewKind.VIDEO_THUMBNAIL ? 180 : 256);
  // A stable synthetic descriptor (no pixels): a deterministic content-derived placeholder id.
  const placeholder = crypto.createHash("sha256").update(`${media?.mediaId}|${kind}|${width}x${height}`).digest("hex").slice(0, 24);
  return { metadata: { width, height, format: "webp", size: Math.max(1, Math.round((width * height) / 32)), placeholder, generatedBy: "default-metadata-generator" } };
}

/**
 * Run a generation cycle over a record with a (possibly injected) generator. Async + pluggable. Returns
 * a NEW record (READY or FAILED) with the version bumped + a history entry. Pure aside from calling the
 * generator. @param {object} record @param {object} params { media, generator?, at? }
 */
export async function runGeneration(record, { media, generator, at } = {}) {
  const nowIso = at ?? new Date().toISOString();
  const gen = generator ?? defaultThumbnailGenerator;
  try {
    const result = await gen({ media, kind: record.kind });
    if (!result || typeof result !== "object" || !result.metadata) throw new PreviewError("generator returned no metadata");
    const version = (record.version ?? 0) + 1;
    const metadata = { ...result.metadata, previewMediaId: result.previewMediaId ?? null };
    return {
      ...record,
      state: PreviewState.READY,
      version,
      metadata,
      history: [...(record.history ?? []), { version, at: nowIso, outcome: "ready" }].slice(-20),
      updatedAt: nowIso,
    };
  } catch (error) {
    return {
      ...record,
      state: PreviewState.FAILED,
      history: [...(record.history ?? []), { version: record.version ?? 0, at: nowIso, outcome: "failed", reason: error?.message }].slice(-20),
      updatedAt: nowIso,
    };
  }
}

export { PreviewKind, PreviewState };
