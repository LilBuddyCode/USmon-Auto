// src/app/api/admin/db-scrub/route.ts
// One-shot DB scrub to rename old seed data: customer + supplier + tech rows
// that were inserted before code was sanitized.
//
// Auth: ?password= matching DASHBOARD_PASSWORD env var.
//
// Usage:
//   curl "https://<host>/api/admin/db-scrub?password=<PWD>"
//
// SAFE TO DELETE AFTER RUNNING. Idempotent, but only needed once.

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const provided = url.searchParams.get('password');
  const expected = process.env.DASHBOARD_PASSWORD;

  if (!expected || provided !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const results: Record<string, unknown> = {};

  // BEFORE snapshot
  const beforeSuppliers = await query(
    `SELECT id, name, notes FROM suppliers`
  );
  const beforeLocations = await query(
    `SELECT id, name, usmon_location_id FROM locations`
  );
  results.before = {
    suppliers: beforeSuppliers.rows,
    locations: beforeLocations.rows,
  };

  // Rename supplier + scrub supplier notes
  const supplierUpdate = await query(
    `UPDATE suppliers
       SET name = 'Primary Supplier, Inc.',
           notes = REGEXP_REPLACE(
                     REGEXP_REPLACE(
                       REGEXP_REPLACE(
                         REGEXP_REPLACE(COALESCE(notes, ''), 'NEUROGUARD', '[product line]', 'g'),
                         '1038 Techne Center Drive, Milford OH 45150', '[supplier HQ address]', 'g'
                       ),
                       'Techne Center Drive', '[supplier address]', 'g'
                     ),
                     'neurosupply\\.com', '[supplier-website]', 'g'
                   )
       WHERE name ILIKE 'Consolidated Neuro Supply%'
          OR notes ILIKE '%NEUROGUARD%'
          OR notes ILIKE '%Techne%'
          OR notes ILIKE '%neurosupply%'
       RETURNING id, name`
  );
  results.suppliers_updated = supplierUpdate.rowCount;

  // Rename location + scrub usmon_location_id slug
  const locationUpdate = await query(
    `UPDATE locations
       SET usmon_location_id = REPLACE(usmon_location_id, 'tech-neil-mendoza', 'tech-field-1'),
           name = CASE
             WHEN name ILIKE '%Neil Mendoza%'              THEN REPLACE(name, 'Neil Mendoza', 'Field Tech 1')
             WHEN name ILIKE '%Spine Sentric Main Warehouse%' THEN 'Operator HQ'
             WHEN name ILIKE '%Spine Sentric%'             THEN REPLACE(name, 'Spine Sentric', 'Operator')
             ELSE name
           END
       WHERE usmon_location_id ILIKE 'tech-neil%'
          OR name ILIKE '%Neil Mendoza%'
          OR name ILIKE '%Spine Sentric%'
       RETURNING id, name, usmon_location_id`
  );
  results.locations_updated = locationUpdate.rowCount;

  // Scrub denormalized snapshot fields on reorders (where the page actually reads from)
  const reorderUpdate = await query(
    `UPDATE reorders
       SET supplier_name_snapshot =
             CASE
               WHEN supplier_name_snapshot ILIKE '%Consolidated Neuro%' THEN 'Primary Supplier, Inc.'
               WHEN supplier_name_snapshot ILIKE '%Spine Sentric%'      THEN 'Operator HQ'
               ELSE supplier_name_snapshot
             END,
           notes = REGEXP_REPLACE(
                     REGEXP_REPLACE(
                       REGEXP_REPLACE(
                         REGEXP_REPLACE(COALESCE(notes, ''), 'Consolidated Neuro Supply, Inc\\.', 'Primary Supplier, Inc.', 'g'),
                         'Consolidated Neuro Supply', 'Primary Supplier', 'g'
                       ),
                       'Neil Mendoza', 'Field Tech 1', 'g'
                     ),
                     'NEUROGUARD', '[product line]', 'g'
                   )
       WHERE supplier_name_snapshot ILIKE '%Consolidated%'
          OR supplier_name_snapshot ILIKE '%Spine Sentric%'
          OR notes ILIKE '%Neil Mendoza%'
          OR notes ILIKE '%Consolidated%'
          OR notes ILIKE '%NEUROGUARD%'
       RETURNING id, supplier_name_snapshot`
  );
  results.reorders_updated = reorderUpdate.rowCount;

  // Also scrub supply_requests.reporter_first_name if it carries customer-identifying values
  const supplyReqUpdate = await query(
    `UPDATE supply_requests
       SET reporter_first_name = 'Tech'
       WHERE reporter_first_name ILIKE '%Latoya%'
          OR reporter_first_name ILIKE '%Toya%'
          OR reporter_first_name ILIKE '%Mendoza%'
       RETURNING id`
  );
  results.supply_requests_updated = supplyReqUpdate.rowCount;

  // And telegram_users.first_name for similar reasons
  const telegramUserUpdate = await query(
    `UPDATE telegram_users
       SET first_name = 'Operator'
       WHERE first_name ILIKE '%Latoya%' OR first_name ILIKE '%Toya%'
       RETURNING id`
  );
  results.telegram_users_updated = telegramUserUpdate.rowCount;

  // AFTER snapshot
  const afterSuppliers = await query(
    `SELECT id, name, notes FROM suppliers`
  );
  const afterLocations = await query(
    `SELECT id, name, usmon_location_id FROM locations`
  );
  results.after = {
    suppliers: afterSuppliers.rows,
    locations: afterLocations.rows,
  };

  // Final leak scan
  const leakScan = await query(
    `SELECT 'suppliers' AS t, id::text, name AS sample FROM suppliers
       WHERE name ~* '(Latoya|Spine Sentric|Consolidated Neuro|Mendoza|NEUROGUARD|Techne|neurosupply)'
     UNION ALL
     SELECT 'suppliers.notes' AS t, id::text, LEFT(notes, 80) FROM suppliers
       WHERE notes ~* '(Latoya|Spine Sentric|Consolidated Neuro|Mendoza|NEUROGUARD|Techne|neurosupply)'
     UNION ALL
     SELECT 'locations' AS t, id::text, name FROM locations
       WHERE name ~* '(Latoya|Spine Sentric|Mendoza)' OR usmon_location_id ~* '(neil|mendoza)'`
  );
  results.remaining_leaks = leakScan.rows;
  results.clean = leakScan.rowCount === 0;

  return NextResponse.json(results, { status: 200 });
}
