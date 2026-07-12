/**
 * @module group/metadata
 *
 * **Group metadata management.** The descriptive, versioned facet of a group — name, description,
 * avatar descriptor, tags, visibility, and an announcement flag, plus a `custom` bag for future
 * extension. Metadata is treated as an independently VERSIONED sub-entity: each edit produces a new
 * immutable metadata object with a bumped `version`, and the manager records a history entry, so a
 * client can render "renamed by X" style audit trails and a future synchronizer can reconcile metadata
 * on its own counter.
 *
 * @security Names + descriptions + tags are legitimate PUBLIC group metadata (the group is not
 * encrypted — its *messages* will be, later). The avatar is stored as a DESCRIPTOR (url / mime / size /
 * checksum) — never raw bytes. This module rejects any key/secret material via the validators layer.
 *
 * Pure functions, no I/O — every mutation returns a NEW metadata object (immutable).
 */

import {
  GroupVisibility,
  ALL_VISIBILITIES,
  MAX_GROUP_NAME_LENGTH,
  MAX_GROUP_DESCRIPTION_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
} from "../types/types.js";
import { MetadataValidationError } from "../errors.js";

/** The recognized top-level metadata fields (everything else goes under `custom`). */
export const METADATA_FIELDS = Object.freeze(["name", "description", "avatar", "tags", "visibility", "announcement", "custom"]);

/** Validate + coerce a group name. @throws {MetadataValidationError} */
export function validateName(name) {
  if (typeof name !== "string" || name.trim().length === 0) throw new MetadataValidationError("Group name is required");
  if (name.length > MAX_GROUP_NAME_LENGTH) throw new MetadataValidationError(`Group name exceeds ${MAX_GROUP_NAME_LENGTH} characters`, { details: { length: name.length } });
  return name.trim();
}

/** Validate a description (optional). */
function validateDescription(description) {
  if (description == null) return "";
  if (typeof description !== "string") throw new MetadataValidationError("Group description must be a string");
  if (description.length > MAX_GROUP_DESCRIPTION_LENGTH) throw new MetadataValidationError(`Group description exceeds ${MAX_GROUP_DESCRIPTION_LENGTH} characters`, { details: { length: description.length } });
  return description;
}

/** Validate a visibility flag (optional → private). */
export function validateVisibility(visibility) {
  if (visibility == null) return GroupVisibility.PRIVATE;
  if (!ALL_VISIBILITIES.includes(visibility)) throw new MetadataValidationError(`Invalid visibility "${visibility}"`, { details: { visibility } });
  return visibility;
}

/** Validate + normalize tags (unique, trimmed, bounded). */
function validateTags(tags) {
  if (tags == null) return [];
  if (!Array.isArray(tags)) throw new MetadataValidationError("tags must be an array");
  if (tags.length > MAX_TAGS) throw new MetadataValidationError(`Too many tags (max ${MAX_TAGS})`, { details: { count: tags.length } });
  const out = [];
  const seen = new Set();
  for (const raw of tags) {
    if (typeof raw !== "string") throw new MetadataValidationError("each tag must be a string");
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) throw new MetadataValidationError(`tag exceeds ${MAX_TAG_LENGTH} characters`, { details: { tag } });
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/** Validate an avatar DESCRIPTOR (url/mime/size/checksum). Never raw bytes. */
function validateAvatar(avatar) {
  if (avatar == null) return null;
  if (typeof avatar !== "object" || Array.isArray(avatar)) throw new MetadataValidationError("avatar must be a descriptor object");
  const out = {};
  if (avatar.url != null) {
    if (typeof avatar.url !== "string" || avatar.url.length > 2048) throw new MetadataValidationError("avatar.url must be a string ≤ 2048 chars");
    out.url = avatar.url;
  }
  if (avatar.mime != null) out.mime = String(avatar.mime).slice(0, 128);
  if (avatar.size != null) {
    if (!Number.isFinite(avatar.size) || avatar.size < 0) throw new MetadataValidationError("avatar.size must be a non-negative number");
    out.size = Math.floor(avatar.size);
  }
  if (avatar.checksum != null) out.checksum = String(avatar.checksum).slice(0, 256);
  return out;
}

/** Validate a custom-fields bag (future-extensible; shallow, JSON-serializable). */
function validateCustom(custom) {
  if (custom == null) return {};
  if (typeof custom !== "object" || Array.isArray(custom)) throw new MetadataValidationError("custom metadata must be an object");
  return custom;
}

/**
 * Build the initial metadata object for a new group. @param {object} input
 * @returns {import("../types/types.js").GroupMetadata}
 */
export function createMetadata(input = {}, at = new Date().toISOString()) {
  return {
    name: validateName(input.name),
    description: validateDescription(input.description),
    avatar: validateAvatar(input.avatar),
    tags: validateTags(input.tags),
    visibility: validateVisibility(input.visibility),
    announcement: !!input.announcement,
    custom: validateCustom(input.custom),
    version: 1,
    updatedAt: at,
  };
}

/**
 * Apply a partial patch to existing metadata, returning a NEW metadata object with `version` bumped and
 * a list of the fields that actually changed (for history / events). Only present fields are touched.
 * @returns {{ metadata: import("../types/types.js").GroupMetadata, changed: string[] }}
 */
export function applyMetadataPatch(current, patch = {}, at = new Date().toISOString()) {
  if (!current) throw new MetadataValidationError("cannot patch missing metadata");
  const next = { ...current };
  const changed = [];
  const set = (field, value) => {
    if (JSON.stringify(next[field] ?? null) !== JSON.stringify(value ?? null)) {
      next[field] = value;
      changed.push(field);
    }
  };
  if ("name" in patch) set("name", validateName(patch.name));
  if ("description" in patch) set("description", validateDescription(patch.description));
  if ("avatar" in patch) set("avatar", validateAvatar(patch.avatar));
  if ("tags" in patch) set("tags", validateTags(patch.tags));
  if ("visibility" in patch) set("visibility", validateVisibility(patch.visibility));
  if ("announcement" in patch) set("announcement", !!patch.announcement);
  if ("custom" in patch) set("custom", { ...(next.custom ?? {}), ...validateCustom(patch.custom) });

  if (changed.length) {
    next.version = (current.version ?? 1) + 1;
    next.updatedAt = at;
  }
  return { metadata: next, changed };
}

/** A compact metadata-history entry for auditing an edit. */
export function metadataHistoryEntry({ from, to, changed, actorId, at }) {
  return {
    fromVersion: from?.version ?? null,
    toVersion: to?.version ?? null,
    changed: changed ?? [],
    actorId: actorId ?? null,
    at: at ?? to?.updatedAt ?? new Date().toISOString(),
  };
}

export { GroupVisibility };
