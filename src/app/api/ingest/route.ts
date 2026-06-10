// src/app/api/ingest/route.ts
// CSV ingest endpoint. Accepts multipart upload, runs through PHI detector + parser,
// inserts into items + locations + daily_counts, returns a summary.
//
// Called by:
//   1. Telegram bot webhook (when aunt sends a CSV file via DM)
//   2. Web dashboard upload form (manual)
//
// Per ADR-005, PHI rejection is enforced HERE before any DB write happens.
// If PHI is detected, the entire upload is rejected and zero rows are written.

import { NextRequest, NextResponse } from 'next/server';
import { parseUsmonCsv } from '@/lib/usmon-csv-parser';
import { query, withTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // Vercel: serverless function timeout

interface IngestResponse {
  ok: boolean;
  source_filename?: string;
  rows_ingested?: number;
  rows_skipped?: number;
  warnings?: string[];
  phi_rejected?: boolean;
  rejected_columns?: string[];
  reason?: string;
  suggestion?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse<IngestResponse>> {
  // ── Get the CSV text (supports both multipart form-data and raw text body) ──
  const contentType = req.headers.get('content-type') ?? '';
  let csvText = '';
  let sourceFilename: string | undefined;

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json(
          { ok: false, reason: 'No file uploaded (expected form field name "file")' },
          { status: 400 },
        );
      }
      csvText = await file.text();
      sourceFilename = file.name;
    } else {
      csvText = await req.text();
    }
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          err instanceof Error ? `Body parse: ${err.message}` : 'Unknown body parse error',
      },
      { status: 400 },
    );
  }

  if (!csvText || csvText.trim() === '') {
    return NextResponse.json(
      { ok: false, reason: 'Empty CSV' },
      { status: 400 },
    );
  }

  // ── Parse + PHI gate (per ADR-005) ──
  const parsed = parseUsmonCsv(csvText, sourceFilename);

  if (!parsed.phi_check.passed) {
    return NextResponse.json(
      {
        ok: false,
        source_filename: sourceFilename,
        phi_rejected: true,
        rejected_columns: parsed.phi_check.rejected_columns,
        reason: parsed.phi_check.reason ?? 'PHI detected in CSV',
        suggestion: parsed.phi_check.suggestion ?? undefined,
      },
      { status: 422 }, // Unprocessable Entity — file shape is wrong, not a server bug
    );
  }

  if (!parsed.ok) {
    return NextResponse.json(
      {
        ok: false,
        source_filename: sourceFilename,
        reason: 'CSV parse errors',
        warnings: parsed.warnings,
      },
      { status: 400 },
    );
  }

  // Empty CSVs (headers only) are valid but no-op. Return success with 0 rows.
  if (parsed.items.length === 0) {
    return NextResponse.json({
      ok: true,
      source_filename: sourceFilename,
      rows_ingested: 0,
      rows_skipped: 0,
      warnings: parsed.warnings,
    });
  }

  // ── Insert in a transaction ──
  let rowsIngested = 0;
  let rowsSkipped = 0;

  await withTransaction(async (client) => {
    // Record the import event for audit trail
    const importInsert = await client.query<{ id: number }>(
      `INSERT INTO csv_imports (source_filename, row_count, ingested_at)
       VALUES ($1, $2, NOW())
       RETURNING id`,
      [sourceFilename ?? 'unknown', parsed.items.length],
    );
    const importId = importInsert.rows[0].id;

    for (const item of parsed.items) {
      // Upsert location
      const loc = await client.query<{ id: number }>(
        `INSERT INTO locations (usmon_location_id, name)
         VALUES ($1, $2)
         ON CONFLICT (usmon_location_id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [item.location_id || `unknown-${item.location_name}`, item.location_name],
      );
      const locationId = loc.rows[0].id;

      // Upsert item (item_name + manufacturer is the natural key)
      const itemRow = await client.query<{ id: number }>(
        `INSERT INTO items (name, manufacturer, manufacturer_number)
         VALUES ($1, $2, $3)
         ON CONFLICT (name, manufacturer) DO UPDATE
           SET manufacturer_number = EXCLUDED.manufacturer_number
         RETURNING id`,
        [item.item_name, item.manufacturer, item.manufacturer_number],
      );
      const itemId = itemRow.rows[0].id;

      // Append a daily snapshot. We snapshot every ingest — historical truth.
      await client.query(
        `INSERT INTO daily_counts (item_id, location_id, quantity, recorded_at, csv_import_id)
         VALUES ($1, $2, $3, NOW(), $4)`,
        [itemId, locationId, item.quantity_on_hand, importId],
      );

      rowsIngested++;
    }
  });

  return NextResponse.json({
    ok: true,
    source_filename: sourceFilename,
    rows_ingested: rowsIngested,
    rows_skipped: rowsSkipped,
    warnings: parsed.warnings,
  });
}
