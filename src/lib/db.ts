// src/lib/db.ts
// Neon Postgres client. Single connection pool, lazy-initialized.
// Per ADR-002: Postgres over SQLite for production observability + serverless-friendly.
//
// Connection string lives in env var DATABASE_URL. Pulled from Neon project dashboard.
// We use the pooled connection string (ends in -pooler.) for Vercel serverless functions
// because each invocation gets a fresh function instance.

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

let poolInstance: Pool | null = null;

function getPool(): Pool {
  if (poolInstance) return poolInstance;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Add it in Vercel env vars (Settings → Environment Variables). ' +
        'Get the value from Neon project → Connection Details → Pooled connection.',
    );
  }

  poolInstance = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }, // Neon requires SSL
    max: 5, // Vercel serverless: low pool size per function instance
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  return poolInstance;
}

/**
 * Execute a parameterized query and return the result rows.
 * Always use $1, $2 placeholders — never string-concatenate values into SQL.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const pool = getPool();
  return pool.query<T>(text, params);
}

/**
 * Run a function inside a transaction. Auto-commits on success, rollbacks on throw.
 * Use for CSV ingest where partial-success is unacceptable.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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

/**
 * Quick liveness check — used by /api/health to confirm DB is reachable.
 */
export async function ping(): Promise<{ ok: boolean; ms?: number; error?: string }> {
  const start = Date.now();
  try {
    await query('SELECT 1');
    return { ok: true, ms: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unknown DB error',
    };
  }
}
