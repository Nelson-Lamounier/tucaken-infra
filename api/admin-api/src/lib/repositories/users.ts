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
 *      New users also get a 14-day reverse trial (migration 007).
 *
 * This prevents the duplicate-email crash that occurred when the same person
 * signed in with Google and then with email/password (both paths produce
 * different Cognito subs but the same email).
 *
 * Plan model (migration 007):
 *   Effective plan is derived at query time — no cron job needed:
 *     plan='pro' + subscription_status='active'  → Pro (paid)
 *     plan='free' + trial_ends_at > NOW()         → Trial (active)
 *     plan='free' + trial_ends_at <= NOW()        → Free (expired)
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
  /** True only when a brand-new users row was inserted (Step 3). False for returning users. */
  isNew: boolean;
}

/**
 * Returns true if a users row with the given email already exists.
 * Used at sign-up time to detect cross-provider duplicates before Cognito
 * creates a second native user (which would trigger AliasExistsException or
 * silently merge identities depending on pool config).
 */
export async function userExistsByEmail(pool: Pool, email: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM users WHERE email = $1) AS exists`,
    [email],
  );
  return result.rows[0]?.exists ?? false;
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
      return { id: existingIdentity.rows[0].user_id, isNew: false };
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

    let isNew = false;

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
      // ── Step 3: brand-new user — create users row + start 14-day trial ───
      //
      // Admin accounts (role='admin') skip the trial — they get free access
      // permanently. The trial_started_at / trial_ends_at columns stay NULL.
      const isAdmin = (user.role ?? 'user') === 'admin';
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users
               (email, full_name, avatar_url, auth_provider, role,
                trial_started_at, trial_ends_at,
                created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5,
                $6, $7,
                NOW(), NOW())
        RETURNING id`,
        [
          user.email,
          user.fullName ?? null,
          user.avatarUrl ?? null,
          user.provider,
          user.role ?? 'user',
          isAdmin ? null : new Date(),
          isAdmin ? null : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('upsertUser: INSERT INTO users returned no row');
      userId = row.id;
      isNew  = true;

      // Audit: record trial start for non-admin users
      if (!isAdmin) {
        await client.query(
          `INSERT INTO plan_events (user_id, event_type, from_plan, to_plan, reason)
           VALUES ($1, 'trial_started', NULL, 'free', 'new_user_signup')`,
          [userId],
        );
      }
    }

    // ── Link the Cognito sub to this user (new identity row) ─────────────────
    //
    // ON CONFLICT (user_id, provider): handles two cases —
    //   1. Concurrent requests with the same sub both miss the pod cache and
    //      race to insert; the second is a no-op update to identical values.
    //   2. Sub rotation: Cognito user deleted + recreated (new sub, same email +
    //      provider). Step 1 above missed the old sub; we update it here so
    //      the user can sign in again without a 503.
    await client.query(
      `INSERT INTO user_identities
             (user_id, cognito_sub, provider, provider_user_id, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, provider) DO UPDATE
         SET cognito_sub      = EXCLUDED.cognito_sub,
             provider_user_id = EXCLUDED.provider_user_id`,
      [userId, user.cognitoSub, user.provider, user.providerUserId ?? null],
    );

    await client.query('COMMIT');
    return { id: userId, isNew };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export type EffectivePlan = 'pro' | 'trial' | 'free';

export interface PlanStatus {
  plan:                 string;          // stored column: 'free' | 'pro'
  effectivePlan:        EffectivePlan;   // derived: 'pro' | 'trial' | 'free'
  role:                 string;          // 'user' | 'admin'
  trialStartedAt:       Date | null;
  trialEndsAt:          Date | null;
  trialDaysRemaining:   number | null;   // null when no active trial
  subscriptionStatus:   string | null;
  stripeCustomerId:     string | null;
  stripeSubscriptionId: string | null;
}

/**
 * Returns the plan status for a user, including effective plan derived from
 * trial dates and Stripe subscription state.
 *
 * Call this inside a withUser() transaction — the Queryable param is a
 * PoolClient with SET LOCAL app.current_user_id already applied.
 */
export async function getUserPlanStatus(
  pool: Pick<import('pg').Pool, 'query'>,
  userId: string,
): Promise<PlanStatus | null> {
  const result = await pool.query<{
    plan:                   string;
    role:                   string;
    trial_started_at:       Date | null;
    trial_ends_at:          Date | null;
    subscription_status:    string | null;
    stripe_customer_id:     string | null;
    stripe_subscription_id: string | null;
    effective_plan:         string;
    trial_days_remaining:   number | null;
  }>(
    `SELECT
       plan,
       role,
       trial_started_at,
       trial_ends_at,
       subscription_status,
       stripe_customer_id,
       stripe_subscription_id,
       CASE
         WHEN plan = 'pro' AND subscription_status = 'active' THEN 'pro'
         WHEN plan = 'free' AND trial_ends_at > NOW()          THEN 'trial'
         ELSE 'free'
       END AS effective_plan,
       CASE
         WHEN plan = 'free' AND trial_ends_at > NOW()
           THEN CEIL(EXTRACT(EPOCH FROM (trial_ends_at - NOW())) / 86400)::integer
         ELSE NULL
       END AS trial_days_remaining
     FROM users
    WHERE id = $1`,
    [userId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    plan:                 row.plan,
    effectivePlan:        row.effective_plan as EffectivePlan,
    role:                 row.role,
    trialStartedAt:       row.trial_started_at,
    trialEndsAt:          row.trial_ends_at,
    trialDaysRemaining:   row.trial_days_remaining,
    subscriptionStatus:   row.subscription_status,
    stripeCustomerId:     row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
  };
}

/**
 * Increments the usage counter for a feature in the current month.
 * Returns the new count so the caller can enforce limits before the action.
 *
 * Pattern: call BEFORE the action, reject if count >= limit.
 */
export async function incrementUsageQuota(
  pool: Pick<import('pg').Pool, 'query'>,
  userId: string,
  feature: 'resume_generations' | 'job_applications' | 'coach_runs',
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `INSERT INTO usage_quotas (user_id, feature, period_month, count, updated_at)
          VALUES ($1, $2, DATE_TRUNC('month', NOW())::date, 1, NOW())
     ON CONFLICT (user_id, feature, period_month)
       DO UPDATE SET count      = usage_quotas.count + 1,
                     updated_at = NOW()
       RETURNING count`,
    [userId, feature],
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Returns current usage count for a feature this month (0 if no row exists).
 */
export async function getUsageQuota(
  pool: Pick<import('pg').Pool, 'query'>,
  userId: string,
  feature: 'resume_generations' | 'job_applications' | 'coach_runs',
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count FROM usage_quotas
      WHERE user_id      = $1
        AND feature      = $2
        AND period_month = DATE_TRUNC('month', NOW())::date`,
    [userId, feature],
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Marks a trial nudge as delivered. Returns true on first delivery, false if
 * already delivered (idempotent — safe to call multiple times).
 */
export async function markTrialNudgeDelivered(
  pool: Pick<import('pg').Pool, 'query'>,
  userId: string,
  nudgeDay: 7 | 12,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO trial_nudges (user_id, nudge_day)
          VALUES ($1, $2)
     ON CONFLICT (user_id, nudge_day) DO NOTHING`,
    [userId, nudgeDay],
  );
  return (result.rowCount ?? 0) > 0;
}
