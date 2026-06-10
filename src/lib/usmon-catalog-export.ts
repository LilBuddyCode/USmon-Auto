// src/lib/usmon-catalog-export.ts
// Stage 2 bridge to USmon (per ADR-008 / ADR-009).
//
// Builds a CSV in USmon Supply Inventory's exact import shape, populated from
// the bot's accumulated reorders + supply_requests data.
//
// Pulled out into a shared lib so both:
//   - /api/export/usmon-catalog (download via HTTP)
//   - the webhook handler (sendDocument via Telegram bot button)
// can call the same code path.
//
// Per ADR-005: zero patient identifiers in the export. Operational data only.

import { query } from './db';

interface CatalogRow {
  item_name: string;
  manufacturer: string;
  manufacturer_number: string | null;
  location_name: string;
  location_id: string;
  unit_hand: number;
}

function escapeCsv(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""';
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

export async function buildCatalogCsv(): Promise<{ rows: number; csv: string }> {
  // We want one row per (item, location) pair the customer has ever ordered or
  // had reported at. unit_hand defaults to 0 because we don't track current
  // stock — USmon will let her update on first count.
  // We Cartesian-product items × known locations. For v1 catalog seeding USmon
  // wants every (item, location) combination that could be stocked. Locations
  // without a usmon_location_id are still included (we just emit a hyphen so
  // USmon will generate one on import).
  const r = await query<CatalogRow>(`
    WITH known_items AS (
      SELECT DISTINCT
        item_name_snapshot AS item_name,
        item_id
      FROM reorders
      WHERE item_name_snapshot IS NOT NULL AND item_name_snapshot <> ''
      UNION
      SELECT DISTINCT
        parsed_item AS item_name,
        item_id
      FROM supply_requests
      WHERE parsed_item IS NOT NULL AND parsed_item <> ''
        AND is_supply_report = TRUE
    ),
    known_locations AS (
      SELECT
        id,
        name AS location_name,
        COALESCE(usmon_location_id, '-') AS location_id
      FROM locations
      WHERE active = TRUE
    )
    SELECT
      ki.item_name,
      COALESCE(i.manufacturer, '') AS manufacturer,
      i.manufacturer_number,
      kl.location_name,
      kl.location_id,
      0 AS unit_hand
    FROM known_items ki
    LEFT JOIN items i ON i.id = ki.item_id
    CROSS JOIN known_locations kl
    ORDER BY ki.item_name, kl.location_name
  `);

  // Header row matches USmon's exact column shape (Manufacture, NOT Manufacturer).
  // The typo is honored at the boundary — see usmon-csv-parser.ts.
  const header =
    '"Supply_Item","location_name","location_id","Manufacture","Manufacture_Number","unit_hand"';

  const body = r.rows
    .map((row) =>
      [
        escapeCsv(row.item_name),
        escapeCsv(row.location_name),
        escapeCsv(row.location_id),
        escapeCsv(row.manufacturer),
        escapeCsv(row.manufacturer_number),
        escapeCsv(row.unit_hand),
      ].join(','),
    )
    .join('\n');

  return {
    rows: r.rows.length,
    csv: header + '\n' + body + '\n',
  };
}
