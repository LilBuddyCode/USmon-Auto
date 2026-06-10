// src/app/api/admin/migrate/route.ts
// One-shot migration endpoint. Reads ./schema.sql (committed at build time) and applies it.
// Idempotent — schema.sql uses CREATE TABLE IF NOT EXISTS, so safe to re-run.
//
// Auth: requires ?password= matching DASHBOARD_PASSWORD env var (deliberately simple for v1).
//
// Usage:
//   curl "https://<host>/api/admin/migrate?password=[DASHBOARD_PASSWORD]"
//
// This is a development convenience. Production migrations should use node-pg-migrate (Day 9+).

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const provided = url.searchParams.get('password');
  const expected = process.env.DASHBOARD_PASSWORD;

  if (!expected) {
    return NextResponse.json(
      { ok: false, error: 'DASHBOARD_PASSWORD not configured on server' },
      { status: 500 },
    );
  }

  if (!provided || provided !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // Read schema.sql from the deployed bundle root
  const schemaPath = join(process.cwd(), 'schema.sql');
  let sql: string;
  try {
    sql = readFileSync(schemaPath, 'utf-8');
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `Could not read schema.sql at ${schemaPath}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      },
      { status: 500 },
    );
  }

  const start = Date.now();
  try {
    await query(sql);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `Migration failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
        elapsed_ms: Date.now() - start,
      },
      { status: 500 },
    );
  }

  // Verify by listing tables
  const tablesResult = await query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);

  return NextResponse.json({
    ok: true,
    elapsed_ms: Date.now() - start,
    tables: tablesResult.rows.map((r) => r.table_name),
    table_count: tablesResult.rows.length,
    notes:
      'Migration applied. CREATE TABLE IF NOT EXISTS makes this idempotent — safe to re-run.',
  });
}
