/**
 * @format
 * UserRepository — typed pg queries for users + user_identities.
 *
 * Identity model (after migration 005):
 *
 *   users            — "who" — one row per real person, keyed by email.
 *   user_identities  — "how they log in" — one row per (user × provider).
 *
 * A single user can have multiple identity rows:
 *   { user_id: X, provider: 'google',  cognito_sub: 'uuid-A' }
 *   { user_id: X, provider: 'github',  cognito_sub: 'uuid-B' }
 *   { user_id: X, provider: 'email',   cognito_sub: 'uuid-C' }
 *
 * Linking strategy in upsertUser():
 *   1. Look up by cognito_sub in user_identities → fast path for returning user.
 *   2. Look up by email in users → links a new provider to an existing account
 *      (same person, second sign-in method).
 *   3. Insert a new users row and a new user_identities row → brand-new account.
 *
 * This prevents the duplicate-email crash that occurred when the same person
 * signed in with Google and then with email/password (both paths produce
 * different Cognito subs but the same email).
 */
import type { Pool } from 'pg';

export interface UserProfile {
  /** Cognito `sub` claim — stable per identity, not per person. */
  cognitoSub:      string;
  /** Identity provider — 'google' | 'github' | 'email'. */
  provider:        string;
  email:           string;
  fullName?:       string;
  avatarUrl?:      string;
  /** Provider's own user ID (Google UID, GitHub numeric ID). Undefined for email. */
  providerUserId?: string | undefined;
  /** RDS role to assign on first insert — 'user' | 'admin'. Defaults to 'user'. */
  role?:           string;
}

export interface ProvisionedUser {
  /** RDS users.id UUID — the stable FK anchor for all child tables. */
  id: string;
}

/**
 * Resolves or creates a users row and links the Cognito identity to it.
 *
 * Idempotent — safe to call on every authenticated request.
 * Returns the stable users.id UUID for downstream query scoping.
 */
export async function upsertUser(pool: Pool, user: UserProfile): Promise<ProvisionedUser> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Step 1: fast path — identity already linked ───────────────────────────
    const existingIdentity = await client.query<{ user_id: string }>(
      `SELECT user_id FROM user_identities WHERE cognito_sub = $1`,
      [user.cognitoSub],
    );

    if (existingIdentity.rows[0]) {
      // Returning user — refresh profile fields that may have changed in the IdP
      await client.query(
        `UPDATE users
            SET full_name  = COALESCE($1, full_name),
                avatar_url = COALESCE($2, avatar_url),
                updated_at = NOW()
          WHERE id = $3`,
        [user.fullName ?? null, user.avatarUrl ?? null, existingIdentity.rows[0].user_id],
      );
      await client.query('COMMIT');
      return { id: existingIdentity.rows[0].user_id };
    }

    // ── Step 2: same email, different provider — link new identity to existing user ──
    //
    // Example: signed up with Google, now signing in with GitHub using same email.
    // We merge rather than create a duplicate account.
    const existingUser = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1`,
      [user.email],
    );

    let userId: string;

    if (existingUser.rows[0]) {
      userId = existingUser.rows[0].id;

      // Update profile with any richer data from the new provider
      await client.query(
        `UPDATE users
            SET full_name  = COALESCE($1, full_name),
                avatar_url = COALESCE($2, avatar_url),
                updated_at = NOW()
          WHERE id = $3`,
        [user.fullName ?? null, user.avatarUrl ?? null, userId],
      );
    } else {
      // ── Step 3: brand-new user — create users row ─────────────────────────
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (email, full_name, avatar_url, auth_provider, role, created_at, updated_at)
              VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           RETURNING id`,
        [user.email, user.fullName ?? null, user.avatarUrl ?? null, user.provider, user.role ?? 'user'],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('upsertUser: INSERT INTO users returned no row');
      userId = row.id;
    }

    // ── Link the Cognito sub to this user (new identity row) ─────────────────
    //
    // ON CONFLICT DO NOTHING: race condition guard in case of concurrent requests.
    await client.query(
      `INSERT INTO user_identities
             (user_id, cognito_sub, provider, provider_user_id, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (cognito_sub) DO NOTHING`,
      [userId, user.cognitoSub, user.provider, user.providerUserId ?? null],
    );

    await client.query('COMMIT');
    return { id: userId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
