---
title: PgBouncer Rejects TLS — "The server does not support SSL connections"
type: troubleshooting
tags: [postgresql, pgbouncer, tls, admin-api, kubernetes]
sources:
  - api/admin-api/src/lib/pg.ts
created: 2026-04-29
updated: 2026-04-29
---

## Symptom

Every database query from admin-api fails immediately with:

```
Error: The server does not support SSL connections
```

The error fires before any query reaches PostgreSQL. No SQL is executed —
`node-postgres` rejects the connection during the TLS handshake with
PgBouncer, not with RDS.

## Root cause

The in-cluster PgBouncer deployment (Bitnami 1.23.1) terminates plain TCP
only. It does not negotiate TLS with clients — the connection from the pool
client to PgBouncer is unencrypted within the cluster network.

When `ssl: { rejectUnauthorized: false }` was configured in the `pg.Pool`
constructor, `node-postgres` sent a TLS ClientHello to PgBouncer. PgBouncer
returned an error frame indicating TLS is not supported. `node-postgres`
surfaced this as "The server does not support SSL connections" before
forwarding the `Pool` object to callers.

This happened even though `rejectUnauthorized: false` is often used to
disable certificate validation — it does **not** disable TLS initiation.
The option only affects whether the server certificate is validated once a
TLS session is established; it does not suppress the TLS handshake itself.

## How to diagnose

```bash
# Confirm the error is on the pgbouncer hop, not the RDS hop
kubectl logs -n admin-api -l app=admin-api --tail=50 | grep -i "ssl\|tls\|pgbouncer"

# Confirm PgBouncer is running in plain TCP mode
kubectl exec -n pgbouncer <pod> -- cat /etc/pgbouncer/pgbouncer.ini | grep -i "tls\|ssl\|client_tls"
```

If PgBouncer is operating in plain TCP mode and the admin-api `pg.Pool`
config has an `ssl` key, the TLS handshake will fail on every connection.

## How to fix

Remove the `ssl` option from the `pg.Pool` constructor entirely. Do not
replace it with `ssl: false` — omitting the key is the correct form for
no-TLS connections.

Current correct state in
[`api/admin-api/src/lib/pg.ts`](../../api/admin-api/src/lib/pg.ts#L16-L27):

```typescript
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
```

No `ssl` key. `node-postgres` defaults to plaintext when `ssl` is absent.

## TLS is still maintained end-to-end

Removing TLS on the client→PgBouncer hop does not mean the data travels
unencrypted to RDS. The TLS guarantee is maintained on the PgBouncer→RDS
hop. PgBouncer terminates each client connection and opens its own
TLS-enabled pool toward RDS.

Intra-cluster traffic (admin-api → PgBouncer) is plaintext over the cluster
network. This is the documented Bitnami PgBouncer deployment pattern:
PgBouncer is an in-cluster proxy whose purpose is connection multiplexing,
not transport encryption.

## Related

- admin-api (the client that owns the pool config and PgBouncer
  max-5-connections contract) is documented in the sibling
  [tucaken-app repo](https://github.com/Nelson-Lamounier/tucaken-app/blob/main/docs/projects/admin-api.md)
- [Platform RDS + PgBouncer](../concepts/platform-rds-pgbouncer.md) — pool sizing and connection budget

<!--
Evidence trail (auto-generated):
- Commit: ce134695 — "fix(admin-api): drop SSL on pgbouncer connection" (read on 2026-04-29)
- Source: api/admin-api/src/lib/pg.ts (read on 2026-04-29)
-->
