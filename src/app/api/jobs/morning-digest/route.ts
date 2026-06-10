// src/app/api/jobs/morning-digest/route.ts
// Daily morning push — every 8 AM EST via Vercel Cron (configured in vercel.json).
// DMs the operator a digest of (1) last-24h supply reports, (2) open reorders that
// haven't been marked received in 3+ days.
//
// Auth: Authorization: Bearer [DASHBOARD_PASSWORD] OR ?password=[DASHBOARD_PASSWORD].
//   Vercel Cron is configured to send the bearer token automatically.

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { sendMessage } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function authorized(req: NextRequest): boolean {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET> automatically.
  // For manual testing, DASHBOARD_PASSWORD as query param or Bearer header also works.
  const cronSecret = process.env.CRON_SECRET;
  const dashboardPassword = process.env.DASHBOARD_PASSWORD;

  const auth = req.headers.get('authorization');
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;
  if (dashboardPassword && auth === `Bearer ${dashboardPassword}`) return true;

  const url = new URL(req.url);
  const queryPassword = url.searchParams.get('password');
  if (dashboardPassword && queryPassword === dashboardPassword) return true;
  return false;
}

interface DigestItem {
  parsed_item: string;
  sample_request_id: string;
  count: string;
  locations: string | null;
  reporters: string | null;
  highest_urgency: string;
}

interface OverdueReorder {
  id: string;
  item_name_snapshot: string;
  supplier_name_snapshot: string | null;
  ordered_at_text: string;
  days_open: string;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // ─── 1. Today's list (same SQL as the in-bot view) ──────────────────────────
  const todaysList = await query<DigestItem>(`
    SELECT
      COALESCE(parsed_item, 'unknown item') AS parsed_item,
      MAX(id)::text AS sample_request_id,
      COUNT(*)::text AS count,
      STRING_AGG(DISTINCT COALESCE(parsed_location_hint, ''), ', ') FILTER (WHERE parsed_location_hint IS NOT NULL AND parsed_location_hint <> '') AS locations,
      STRING_AGG(DISTINCT COALESCE(reporter_first_name, 'anon'), ', ') AS reporters,
      CASE MAX(
        CASE parsed_urgency
          WHEN 'high' THEN 3
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 1
          ELSE 0
        END
      )
        WHEN 3 THEN 'high'
        WHEN 2 THEN 'medium'
        WHEN 1 THEN 'low'
        ELSE 'unknown'
      END AS highest_urgency
    FROM supply_requests
    WHERE is_supply_report = TRUE
      AND superseded_by_reorder_id IS NULL
      AND reported_at > NOW() - INTERVAL '24 hours'
    GROUP BY COALESCE(parsed_item, 'unknown item')
    ORDER BY
      MAX(
        CASE parsed_urgency
          WHEN 'high' THEN 3
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 1
          ELSE 0
        END
      ) DESC,
      COUNT(*) DESC
  `);

  // ─── 2. Overdue receipts (ordered >= 3 days ago, not received) ──────────────
  const overdue = await query<OverdueReorder>(`
    SELECT id::text, item_name_snapshot, supplier_name_snapshot,
           TO_CHAR(ordered_at, 'Mon DD') AS ordered_at_text,
           EXTRACT(DAY FROM (NOW() - ordered_at))::text AS days_open
    FROM reorders
    WHERE received_at IS NULL
      AND ordered_at < NOW() - INTERVAL '3 days'
    ORDER BY ordered_at ASC
  `);

  // ─── 3. All active users we should DM ──────────────────────────────────────
  // v1: DM every active user. v2: filter by role='buyer'.
  const users = await query<{ telegram_chat_id: string; first_name: string | null }>(
    `SELECT telegram_chat_id::text, first_name
     FROM telegram_users WHERE active = TRUE`,
  );

  const pushedTo: { chat_id: string; ok: boolean; error?: string }[] = [];

  for (const user of users.rows) {
    const chatId = parseInt(user.telegram_chat_id, 10);
    if (Number.isNaN(chatId)) continue;

    const name = user.first_name ?? 'there';
    const ts = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

    let text = `☕ *Good morning ${name}!*\n_${ts} — your daily inventory snapshot._\n\n`;

    // Section 1: today's list
    if (todaysList.rows.length === 0) {
      text += `📋 *Supply reports (last 24h):*\nNothing reported. All quiet. ✨\n\n`;
    } else {
      text += `📋 *${todaysList.rows.length} item${todaysList.rows.length === 1 ? '' : 's'} reported low:*\n`;
      for (const item of todaysList.rows) {
        const mark =
          item.highest_urgency === 'high' ? '🚨' : item.highest_urgency === 'medium' ? '⏰' : '•';
        const count = parseInt(item.count, 10);
        const countText = count > 1 ? ` _(${count} reports)_` : '';
        const locs = item.locations ? ` _@ ${item.locations}_` : '';
        text += `\n${mark} *${item.parsed_item}*${locs}${countText} — by ${item.reporters ?? 'anon'}`;
      }
      text += `\n\n`;
    }

    // Section 2: overdue receipts
    if (overdue.rows.length > 0) {
      text += `⚠️ *${overdue.rows.length} order${overdue.rows.length === 1 ? '' : 's'} overdue for receipt (3+ days):*\n`;
      for (const row of overdue.rows) {
        const supplier = row.supplier_name_snapshot ?? 'unknown supplier';
        text += `\n• *${row.item_name_snapshot}* from ${supplier} (ordered ${row.ordered_at_text}, ${row.days_open}d ago)`;
      }
      text += `\n\n`;
    }

    text += `_Tap /menu for actions. Have a great day._`;

    try {
      await sendMessage({ chatId, text, parseMode: 'Markdown' });
      pushedTo.push({ chat_id: user.telegram_chat_id, ok: true });

      // Log to alerts for audit trail
      await query(
        `INSERT INTO alerts (channel, tier, body, delivery_status)
         VALUES ($1, $2, $3, $4)`,
        ['telegram', 3, text, 'sent'],
      );
    } catch (err) {
      pushedTo.push({
        chat_id: user.telegram_chat_id,
        ok: false,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  return NextResponse.json({
    ok: true,
    today_items: todaysList.rows.length,
    overdue_reorders: overdue.rows.length,
    users_targeted: users.rows.length,
    pushed_to: pushedTo,
    timestamp: new Date().toISOString(),
  });
}
