// src/app/api/admin/seed/route.ts
// One-shot seed endpoint. Loads real Day 3 catalog data captured from the operator's
// forwarded PO + Invoice (Primary Supplier / [product line]).
//
// Idempotent — uses ON CONFLICT, safe to re-run.
//
// Auth: ?password= matching DASHBOARD_PASSWORD env var (same convention as migrate).
//
// Usage:
//   curl "https://<host>/api/admin/seed?password=[DASHBOARD_PASSWORD]"

import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface SeedItem {
  name: string;                 // canonical lowercase name for parser matching
  manufacturer: string;         // catalog brand ([product line])
  manufacturer_number: string;  // SKU
  category: string;
  unit_of_measure: string;
  typical_pack_size: number;    // pcs per pack (descriptive, stored in notes via name)
}

const SUPPLIER = {
  name: 'Primary Supplier, Inc.',
  contact_name: null as string | null, // "she" — awaiting the operator confirmation
  phone: null as string | null,
  email: null as string | null,
  typical_lead_hours: 4,
  notes:
    'Brand: [product line]. Address: [supplier HQ address]. ' +
    'Website: [supplier-website]. Payment: VISA, pay-on-receipt. Ship-to: tech home addresses. ' +
    'Reorder cadence: every 2-3 months based on captured PO/Invoice.',
};

const ITEMS: SeedItem[] = [
  {
    name: 'parallel pair needle electrodes',
    manufacturer: '[product line]',
    manufacturer_number: 'S46-937',
    category: 'subdermal-needle',
    unit_of_measure: 'pack of 10',
    typical_pack_size: 10,
  },
  {
    name: 'single wire needle electrodes',
    manufacturer: '[product line]',
    manufacturer_number: 'S41-638',
    category: 'subdermal-needle',
    unit_of_measure: 'pack of 24',
    typical_pack_size: 24,
  },
  {
    name: '4-disk adhesive surface electrodes',
    manufacturer: '[product line]',
    manufacturer_number: 'K50430-002',
    category: 'surface-electrode',
    unit_of_measure: 'pack of 40',
    typical_pack_size: 40,
  },
];

// Known location — tech #1 from the ship-to on the captured PO + Invoice.
const TECH_LOCATIONS = [
  {
    usmon_location_id: 'tech-field-1',
    name: 'Field Tech 1',
    kind: 'tech' as const,
  },
];

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const provided = url.searchParams.get('password');
  const expected = process.env.DASHBOARD_PASSWORD;

  if (!expected || provided !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const start = Date.now();

  try {
    const result = await withTransaction(async (client) => {
      // ── Supplier ──
      await client.query(
        `INSERT INTO suppliers (name, contact_name, phone, email, typical_lead_hours, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [
          SUPPLIER.name,
          SUPPLIER.contact_name,
          SUPPLIER.phone,
          SUPPLIER.email,
          SUPPLIER.typical_lead_hours,
          SUPPLIER.notes,
        ],
      );

      // ── Items ──
      const insertedItems: { name: string; sku: string; id: number }[] = [];
      for (const item of ITEMS) {
        const r = await client.query<{ id: number }>(
          `INSERT INTO items (name, manufacturer, manufacturer_number, category, unit_of_measure)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (name, manufacturer) DO UPDATE
             SET manufacturer_number = EXCLUDED.manufacturer_number,
                 category = EXCLUDED.category,
                 unit_of_measure = EXCLUDED.unit_of_measure
           RETURNING id`,
          [item.name, item.manufacturer, item.manufacturer_number, item.category, item.unit_of_measure],
        );
        insertedItems.push({ name: item.name, sku: item.manufacturer_number, id: r.rows[0].id });
      }

      // ── Locations (techs as locations) ──
      const insertedLocations: { name: string; id: number }[] = [];
      for (const loc of TECH_LOCATIONS) {
        const r = await client.query<{ id: number }>(
          `INSERT INTO locations (usmon_location_id, name, kind)
           VALUES ($1, $2, $3)
           ON CONFLICT (usmon_location_id) DO UPDATE
             SET name = EXCLUDED.name, kind = EXCLUDED.kind
           RETURNING id`,
          [loc.usmon_location_id, loc.name, loc.kind],
        );
        insertedLocations.push({ name: loc.name, id: r.rows[0].id });
      }

      // ── Final counts ──
      const counts = await client.query<{
        suppliers: string;
        items: string;
        locations: string;
      }>(`
        SELECT
          (SELECT COUNT(*)::text FROM suppliers) AS suppliers,
          (SELECT COUNT(*)::text FROM items) AS items,
          (SELECT COUNT(*)::text FROM locations) AS locations
      `);

      return {
        items: insertedItems,
        locations: insertedLocations,
        counts: counts.rows[0],
      };
    });

    return NextResponse.json({
      ok: true,
      elapsed_ms: Date.now() - start,
      seeded: result,
      notes:
        'Seed data from the operator forwarded PO + Invoice. [product line] items via ' +
        'Primary Supplier. Re-run is safe (idempotent via ON CONFLICT).',
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown seed error',
        elapsed_ms: Date.now() - start,
      },
      { status: 500 },
    );
  }
}
