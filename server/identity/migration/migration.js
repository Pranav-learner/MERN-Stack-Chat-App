/**
 * @module identity/migration
 *
 * Migration & backward-compatibility helpers.
 *
 * ## Why there is no destructive migration
 * Identity introduces two NEW MongoDB collections (`identities`, `devices`) and
 * does not alter the existing `User`/`Message`/`Group` schemas. MongoDB is
 * schemaless, so no ALTER-style migration is required and existing documents are
 * untouched.
 *
 * ## Existing users
 * Existing users simply have no identity yet. The server CANNOT create identities
 * for them, because identity generation requires a private key that only lives on
 * the user's device. Backfill is therefore **client-driven**: the next time an
 * identity-aware client logs in, it generates the identity locally and registers
 * the public key. Until then, identity lookups return `null` gracefully.
 *
 * This module provides a read-only report so operators can see adoption.
 */

/**
 * Report which users do not yet have an identity (adoption/backfill visibility).
 * Read-only; performs no writes.
 *
 * @param {object} params
 * @param {import("mongoose").Model} params.UserModel the existing User model
 * @param {object} params.identities identity repository
 * @returns {Promise<{ totalUsers: number, withIdentity: number, withoutIdentity: number,
 *                     missing: Array<{ userId: string, email: string }> }>}
 * @example
 * const report = await reportIdentityAdoption({ UserModel: User, identities });
 */
export async function reportIdentityAdoption({ UserModel, identities }) {
  const users = await UserModel.find({}, { email: 1 }).lean();
  const missing = [];
  let withIdentity = 0;
  for (const user of users) {
    const identity = await identities.findByUser(user._id);
    if (identity) withIdentity += 1;
    else missing.push({ userId: String(user._id), email: user.email });
  }
  return {
    totalUsers: users.length,
    withIdentity,
    withoutIdentity: missing.length,
    missing,
  };
}

/** Current identity storage schema version (for future forward-migrations). */
export const IDENTITY_SCHEMA_VERSION = 1;
