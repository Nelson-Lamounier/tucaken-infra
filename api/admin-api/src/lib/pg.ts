/**
 * @format
 * Lazy Pool singleton + RLS helpers for admin-api.
 *
 * Connection model:
 *   Pool connects as the superuser (postgres) via PgBouncer (transaction mode).
 *   Max 5 client connections: PgBouncer multiplexes these into ≤20 server connections.
 *   No TLS on the client→pgbouncer hop: intra-cluster only; pgbouncer opens its own
 *   TLS-enabled pool to RDS on the egress hop.
 *
 * RLS enforcement model:
 *   For user-scoped queries, withUser() wraps the work in a transaction that:
 *     1. SET LOCAL ROLE tucaken_app  — demotes to the low-privilege role that RLS applies to
 *     2. SET LOCAL app.current_user_id = $userId  — drives the isolation policies
 *   Both settings are transaction-local and revert automatically on COMMIT/ROLLBACK.
 *   Superuser queries (provisioning, article writes) run outside withUser() and bypass RLS.
 */
import { Pool, type PoolClient } from 'pg';

import type { AdminApiConfig } from './config.js';

/** Shared interface satisfied by both Pool and PoolClient — use in repository signatures. */
export type Queryable = Pick<Pool, 'query'>;

let _pool: Pool | undefined;

export function getPool(config: AdminApiConfig): Pool {
    if (!_pool) {
        _pool = new Pool({
            host:     config.pgHost,
            port:     config.pgPort,
            database: config.pgDatabase,
            user:     config.pgUser,
            password: config.pgPassword,
            max:      5,
            idleTimeoutMillis:       30_000,
            connectionTimeoutMillis:  5_000,
        });
    }
    return _pool;
}

/**
 * Run `fn` inside a transaction scoped to a single user.
 *
 * Sets `ROLE tucaken_app` so RLS policies are enforced, then sets
 * `app.current_user_id` so the isolation policies match rows to this user.
 * Both are transaction-local: the superuser role and no user_id setting
 * are restored automatically on commit or rollback.
 *
 * @param pool   - The singleton pool (connects as superuser).
 * @param userId - The users.id UUID from the provisioned users row.
 * @param fn     - Work to run under RLS. Receives the acquired PoolClient.
 */
export async function withUser<T>(
    pool: Pool,
    userId: string,
    fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE tucaken_app');
        await client.query('SET LOCAL app.current_user_id = $1', [userId]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/** For tests only — reset singleton between test suites. */
export function _resetPool(): void {
    _pool = undefined;
}
