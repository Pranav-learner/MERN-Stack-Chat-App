/**
 * @module repository
 *
 * Typed repositories, one per {@link KeyType}. Each is a thin specialization of
 * {@link BaseKeyRepository} pinned to its type, so callers get type-scoped queries
 * and the architecture already accommodates the future protocol key types
 * (prekeys, signed prekeys, one-time keys, group keys) without redesign.
 */

import { KeyType } from "../types/index.js";
import { BaseKeyRepository, type RepositoryContext } from "./base-repository.js";

export { BaseKeyRepository, type RepositoryContext } from "./base-repository.js";

/** Repository for long-term identity signing keys (Ed25519). */
export class IdentityKeyRepository extends BaseKeyRepository {
  constructor(ctx: RepositoryContext) {
    super(KeyType.IDENTITY, ctx);
  }
}

/** Repository for symmetric session keys (AES-256). */
export class SessionKeyRepository extends BaseKeyRepository {
  constructor(ctx: RepositoryContext) {
    super(KeyType.SESSION, ctx);
  }
}

/** Repository for Diffie–Hellman shared secrets. */
export class SharedSecretRepository extends BaseKeyRepository {
  constructor(ctx: RepositoryContext) {
    super(KeyType.SHARED_SECRET, ctx);
  }
}

/** Repository for ephemeral key-agreement prekeys (X25519). Future protocol use. */
export class PreKeyRepository extends BaseKeyRepository {
  constructor(ctx: RepositoryContext) {
    super(KeyType.PREKEY, ctx);
  }
}

/** Repository for signed prekeys. Future protocol use. */
export class SignedPreKeyRepository extends BaseKeyRepository {
  constructor(ctx: RepositoryContext) {
    super(KeyType.SIGNED_PREKEY, ctx);
  }
}

/** Repository for one-time prekeys. Future protocol use. */
export class OneTimeKeyRepository extends BaseKeyRepository {
  constructor(ctx: RepositoryContext) {
    super(KeyType.ONE_TIME_PREKEY, ctx);
  }
}

/** Repository for group/sender keys. Future protocol use. */
export class GroupKeyRepository extends BaseKeyRepository {
  constructor(ctx: RepositoryContext) {
    super(KeyType.GROUP, ctx);
  }
}
