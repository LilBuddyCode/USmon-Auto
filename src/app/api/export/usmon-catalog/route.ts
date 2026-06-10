// src/app/api/export/usmon-catalog/route.ts
// Stage 2 bridge to USmon (per ADR-008).
//
// Pulls every item we've seen across reorders + locations the bot has
// accumulated, and emits a CSV in the EXACT shape USmon's Supply Inventory
// expects (per our scouting in _data/scouting-log.md — Setup Supplies columns):
//
//   Supply_Item, location_name, location_id, Manufacture, Manufacture_Number, unit_hand
//
// The customer takes the file and uses USmon's "Import Supply Items from Master
// Suppliers List" button (Setup Supplies tab) to populate USmon's catalog in
// one paste. After that, USmon has a real catalog reflecting what their
// business actually orders.
//
// Per ADR-005: this export contains ZERO patient identifiers. It contains
// operational item + manufacturer + location data only.
//
// Auth: ?password=[DASHBOARD_PASSWORD] for manual download.
//       Also called by the bot's "📤 Export catalog to USmon" button via
//       sending a file directly to Telegram (handled in webhook route).

import { NextRequest, NextResponse } from 'next/server';
import { buildCatalogCsv } from '@/lib/usmon-catalog-export';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function authorized(req: NextRequest): boolean {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return false;
  const url = new URL(req.url);
  if (url.searchParams.get('password') === expected) return true;
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${expected}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const { rows, csv } = await buildCatalogCsv();
  const filename = `usmon-catalog-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'x-usmon-catalog-rows': String(rows),
    },
  });
}
