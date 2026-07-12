/**
 * @module group/types
 *
 * Enums + constants for the **Group Foundation & Membership Management** subsystem — Layer 10, Sprint 1.
 * It models a Group as a FIRST-CLASS DISTRIBUTED ENTITY: an entity with its own identity, lifecycle,
 * membership, roles, permissions, versioned metadata, and replica state. This sprint is the foundation
 * for future secure group messaging — it establishes the control-plane shape but implements NO group
 * messaging, encryption, rekeying, fan-out, delivery tracking, or read receipts (later sprints).
 *
 * @security A group + its membership + metadata carry PUBLIC control-plane data ONLY (names, roles,
 * states, versions, counts) — never message plaintext, ciphertext bytes, or key material. Group
 * encryption keys are derived later (Sprint 2) and NEVER stored here. {@link module:group/validators}
 * enforces the no-secret invariant.
 *
 * @evolution Transport-, encryption-, and networking-INDEPENDENT. Versioning is a per-facet SCALAR
 * counter vector (a seam a FUTURE vector-clock / Layer-9 replication hybrid drops into WITHOUT changing
 * callers). Group messaging (Sprint 2) CONSUMES this subsystem's entities + events; it does not modify
 * them.
 */

/**
 * The role a member holds inside a group. Roles are RANKED (see {@link ROLE_RANK}); a role can only
 * manage members whose role ranks strictly lower. `MODERATOR` + `GUEST` are future-ready (defined,
 * assignable, permissioned) so Sprint 2 needs no schema change.
 * @readonly @enum {string}
 */
export const GroupRole = Object.freeze({
  OWNER: "owner", // the single ultimate authority; exactly one per group
  ADMINISTRATOR: "administrator", // full management short of delete/transfer/permission-policy
  MODERATOR: "moderator", // future-ready: member moderation (mute/remove) without metadata control
  MEMBER: "member", // an ordinary participant
  GUEST: "guest", // future-ready: read-mostly, limited participant
});

export const ALL_ROLES = Object.freeze(Object.values(GroupRole));

/** Role rank — higher outranks lower. A member may only act on strictly-lower-ranked members. */
export const ROLE_RANK = Object.freeze({
  [GroupRole.OWNER]: 100,
  [GroupRole.ADMINISTRATOR]: 80,
  [GroupRole.MODERATOR]: 60,
  [GroupRole.MEMBER]: 40,
  [GroupRole.GUEST]: 20,
});

/**
 * The lifecycle state of a single membership (one member inside one group). Every mutation is a
 * validated transition (see {@link MEMBERSHIP_TRANSITIONS}).
 * @readonly @enum {string}
 */
export const MembershipState = Object.freeze({
  INVITED: "invited", // an admin invited this user; awaiting their accept/reject
  PENDING: "pending", // this user requested to join; awaiting admin approval
  ACTIVE: "active", // a full participant
  MUTED: "muted", // a participant who cannot post (future messaging honours this); still a member
  ARCHIVED: "archived", // the member archived the group locally; still a member
  LEFT: "left", // the member voluntarily left
  REMOVED: "removed", // an admin removed the member (may be re-invited)
  BANNED: "banned", // an admin banned the member (cannot rejoin until unbanned)
  DELETED: "deleted", // membership tombstone (terminal)
});

export const ALL_MEMBERSHIP_STATES = Object.freeze(Object.values(MembershipState));

/** States that count a member as "in" the group (participates in size + fan-out later). */
export const ACTIVE_MEMBERSHIP_STATES = Object.freeze([
  MembershipState.ACTIVE,
  MembershipState.MUTED,
  MembershipState.ARCHIVED,
]);

/** States awaiting a decision (not yet a full member). */
export const PENDING_MEMBERSHIP_STATES = Object.freeze([MembershipState.INVITED, MembershipState.PENDING]);

/** Terminal state — no further transitions are allowed. */
export const TERMINAL_MEMBERSHIP_STATES = Object.freeze([MembershipState.DELETED]);

/**
 * The allowed membership state machine: `from → [allowed to states]`. Any transition not listed is
 * rejected by {@link module:group/lifecycle}. Kept deliberately permissive for revival (re-invite /
 * rejoin) but strict about `banned` + `deleted`.
 */
export const MEMBERSHIP_TRANSITIONS = Object.freeze({
  [MembershipState.INVITED]: Object.freeze([MembershipState.ACTIVE, MembershipState.LEFT, MembershipState.REMOVED, MembershipState.BANNED, MembershipState.DELETED]),
  [MembershipState.PENDING]: Object.freeze([MembershipState.ACTIVE, MembershipState.REMOVED, MembershipState.BANNED, MembershipState.DELETED]),
  [MembershipState.ACTIVE]: Object.freeze([MembershipState.MUTED, MembershipState.ARCHIVED, MembershipState.LEFT, MembershipState.REMOVED, MembershipState.BANNED, MembershipState.DELETED]),
  [MembershipState.MUTED]: Object.freeze([MembershipState.ACTIVE, MembershipState.ARCHIVED, MembershipState.LEFT, MembershipState.REMOVED, MembershipState.BANNED, MembershipState.DELETED]),
  [MembershipState.ARCHIVED]: Object.freeze([MembershipState.ACTIVE, MembershipState.MUTED, MembershipState.LEFT, MembershipState.REMOVED, MembershipState.BANNED, MembershipState.DELETED]),
  [MembershipState.LEFT]: Object.freeze([MembershipState.ACTIVE, MembershipState.INVITED, MembershipState.REMOVED, MembershipState.BANNED, MembershipState.DELETED]),
  [MembershipState.REMOVED]: Object.freeze([MembershipState.ACTIVE, MembershipState.INVITED, MembershipState.BANNED, MembershipState.DELETED]),
  [MembershipState.BANNED]: Object.freeze([MembershipState.REMOVED, MembershipState.DELETED]),
  [MembershipState.DELETED]: Object.freeze([]),
});

/**
 * The lifecycle state of the Group entity itself (distinct from a member's state).
 * @readonly @enum {string}
 */
export const GroupState = Object.freeze({
  ACTIVE: "active", // the normal operating state
  ARCHIVED: "archived", // frozen (no membership mutations) but retained
  DELETED: "deleted", // soft-deleted tombstone (terminal)
});

export const ALL_GROUP_STATES = Object.freeze(Object.values(GroupState));

/** Allowed Group-entity lifecycle transitions. */
export const GROUP_STATE_TRANSITIONS = Object.freeze({
  [GroupState.ACTIVE]: Object.freeze([GroupState.ARCHIVED, GroupState.DELETED]),
  [GroupState.ARCHIVED]: Object.freeze([GroupState.ACTIVE, GroupState.DELETED]),
  [GroupState.DELETED]: Object.freeze([]),
});

/**
 * Group visibility — who can discover / request to join. Discovery + join enforcement is a future
 * concern; this sprint stores + validates the flag.
 * @readonly @enum {string}
 */
export const GroupVisibility = Object.freeze({
  PRIVATE: "private", // invite-only, not discoverable
  PUBLIC: "public", // discoverable + open join
  HIDDEN: "hidden", // not discoverable, join by direct link/id only
  INVITE_ONLY: "invite-only", // discoverable but join requires an invite
});

export const ALL_VISIBILITIES = Object.freeze(Object.values(GroupVisibility));

/**
 * Configurable permissions a role may hold. `DELETE_GROUP`, `TRANSFER_OWNERSHIP`, and
 * `MANAGE_PERMISSIONS` are owner-only by default. Deployments override per-group via permission
 * overrides (see {@link module:group/permissions}). Future policy extensions add keys here without
 * breaking callers.
 * @readonly @enum {string}
 */
export const GroupPermission = Object.freeze({
  VIEW_GROUP: "view-group",
  VIEW_MEMBERS: "view-members",
  INVITE_MEMBERS: "invite-members",
  REMOVE_MEMBERS: "remove-members",
  APPROVE_JOIN_REQUESTS: "approve-join-requests",
  MUTE_MEMBERS: "mute-members",
  EDIT_METADATA: "edit-metadata",
  MANAGE_ROLES: "manage-roles",
  MANAGE_PERMISSIONS: "manage-permissions",
  TRANSFER_OWNERSHIP: "transfer-ownership",
  DELETE_GROUP: "delete-group",
});

export const ALL_PERMISSIONS = Object.freeze(Object.values(GroupPermission));

/** The default permission set granted to each role. A per-group override layer refines this. */
export const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  [GroupRole.OWNER]: Object.freeze([...ALL_PERMISSIONS]),
  [GroupRole.ADMINISTRATOR]: Object.freeze([
    GroupPermission.VIEW_GROUP,
    GroupPermission.VIEW_MEMBERS,
    GroupPermission.INVITE_MEMBERS,
    GroupPermission.REMOVE_MEMBERS,
    GroupPermission.APPROVE_JOIN_REQUESTS,
    GroupPermission.MUTE_MEMBERS,
    GroupPermission.EDIT_METADATA,
    GroupPermission.MANAGE_ROLES,
  ]),
  [GroupRole.MODERATOR]: Object.freeze([
    GroupPermission.VIEW_GROUP,
    GroupPermission.VIEW_MEMBERS,
    GroupPermission.APPROVE_JOIN_REQUESTS,
    GroupPermission.MUTE_MEMBERS,
    GroupPermission.REMOVE_MEMBERS,
  ]),
  [GroupRole.MEMBER]: Object.freeze([GroupPermission.VIEW_GROUP, GroupPermission.VIEW_MEMBERS]),
  [GroupRole.GUEST]: Object.freeze([GroupPermission.VIEW_GROUP]),
});

/** The facets that carry an independent monotonic version counter. */
export const VersionKind = Object.freeze({
  GROUP: "group", // the aggregate entity version (bumps on ANY change)
  MEMBERSHIP: "membership", // bumps on membership add/remove/state/role change
  METADATA: "metadata", // bumps on name/description/avatar/tags/visibility change
  ROLE: "role", // bumps on a role assignment change
  PERMISSION: "permission", // bumps on a permission-override change
  REPLICA: "replica", // bumps on a replica-state refresh
});

export const ALL_VERSION_KINDS = Object.freeze(Object.values(VersionKind));

/**
 * Group control-plane event types. A FUTURE Layer 10 Sprint 2 (secure group messaging) CONSUMES these
 * to fan out membership/metadata/role changes. @readonly @enum {string}
 */
export const GroupEventType = Object.freeze({
  GROUP_CREATED: "group.created",
  GROUP_DELETED: "group.deleted",
  GROUP_ARCHIVED: "group.archived",
  GROUP_RESTORED: "group.restored",
  MEMBER_INVITED: "group.member_invited",
  INVITATION_ACCEPTED: "group.invitation_accepted",
  INVITATION_REJECTED: "group.invitation_rejected",
  JOIN_REQUESTED: "group.join_requested",
  MEMBER_JOINED: "group.member_joined",
  MEMBER_LEFT: "group.member_left",
  MEMBER_REMOVED: "group.member_removed",
  MEMBER_BANNED: "group.member_banned",
  MEMBER_MUTED: "group.member_muted",
  MEMBERSHIP_STATE_CHANGED: "group.membership_state_changed",
  OWNERSHIP_TRANSFERRED: "group.ownership_transferred",
  METADATA_UPDATED: "group.metadata_updated",
  ROLE_CHANGED: "group.role_changed",
  PERMISSION_CHANGED: "group.permission_changed",
  GROUP_VERSION_UPDATED: "group.version_updated",
  REPLICA_UPDATED: "group.replica_updated",
});

/** Machine-readable failure/validation reasons. */
export const GroupFailureReason = Object.freeze({
  UNKNOWN_GROUP: "unknown-group",
  DUPLICATE_GROUP: "duplicate-group",
  UNKNOWN_MEMBER: "unknown-member",
  DUPLICATE_MEMBER: "duplicate-member",
  DUPLICATE_INVITATION: "duplicate-invitation",
  INVALID_ROLE: "invalid-role",
  INVALID_STATE_TRANSITION: "invalid-state-transition",
  INVALID_METADATA: "invalid-metadata",
  INVALID_OWNERSHIP: "invalid-ownership",
  CIRCULAR_OWNERSHIP: "circular-ownership",
  PERMISSION_DENIED: "permission-denied",
  VERSION_CONFLICT: "version-conflict",
  UNAUTHORIZED: "unauthorized",
  GROUP_NOT_ACTIVE: "group-not-active",
  LIMIT_EXCEEDED: "limit-exceeded",
  INTERNAL_ERROR: "internal-error",
});

/** The subsystem identifier + schema version. */
export const GROUP_FRAMEWORK = "group";
export const GROUP_SCHEMA_VERSION = 1;

/** Operational limits (defensive; a deployment may override on the manager). */
export const MAX_GROUP_NAME_LENGTH = 200;
export const MAX_GROUP_DESCRIPTION_LENGTH = 2000;
export const MAX_TAGS = 32;
export const MAX_TAG_LENGTH = 64;
export const DEFAULT_MAX_MEMBERS = 100_000;

/** Pagination bounds (API hardening). */
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 100;

/**
 * @typedef {object} VersionVector A group's per-facet monotonic version counters.
 * @property {number} group @property {number} membership @property {number} metadata
 * @property {number} role @property {number} permission @property {number} replica
 */

/**
 * @typedef {object} GroupMetadata The versioned descriptive facet of a group.
 * @property {string} name @property {string} description @property {object} [avatar] avatar descriptor
 * (url/mime/size/checksum — never bytes) @property {string[]} tags @property {string} visibility
 * @property {boolean} announcement announcement-only flag @property {object} [custom] future custom fields
 * @property {number} version @property {string} updatedAt
 */

/**
 * @typedef {object} Group The first-class group entity.
 * @property {string} groupId @property {string} ownerId @property {string} state one of {@link GroupState}
 * @property {GroupMetadata} metadata @property {string} visibility @property {VersionVector} versions
 * @property {object} permissionOverrides per-role permission grants/revokes @property {object} audit
 * @property {string} createdAt @property {string} updatedAt @property {number} schemaVersion
 */

/**
 * @typedef {object} Membership One member's record inside one group.
 * @property {string} membershipId @property {string} groupId @property {string} memberId
 * @property {string} role one of {@link GroupRole} @property {string} state one of {@link MembershipState}
 * @property {string|null} invitedBy @property {string} invitedAt @property {string|null} joinedAt
 * @property {object} metadata @property {number} version @property {string} createdAt @property {string} updatedAt
 */
