// src/app/api/health/route.ts
// Health check — used by Vercel deployment monitor + Telegram bot startup probe.
// Returns 200 with build metadata + DB ping.
// If DB is unreachable, returns 503 with the reason (so we can spot config issues fast).

import { NextResponse } from 'next/server';
import { ping } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const db = await ping();
  const status = db.ok ? 200 : 503;

  return NextResponse.json(
    {
      service: 'usmon-auto',
      version: '0.1.0',
      env: process.env.APP_ENV ?? 'unknown',
      vercel_url: process.env.VERCEL_URL,
      vercel_git_commit_sha: process.env.VERCEL_GIT_COMMIT_SHA,
      vercel_git_commit_message: process.env.VERCEL_GIT_COMMIT_MESSAGE,
      timestamp: new Date().toISOString(),
      db,
    },
    { status },
  );
}
