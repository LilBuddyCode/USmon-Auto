// src/lib/usmon-csv-parser.ts
// Parses CSV exports from USmon Inventory Reports → Stock Per Supply → MS Excel (CSV).
// Column shape locked Day 1 from real export: inventory_*.csv from the customer.
//
// USmon's raw column names (typos preserved — "Manufacture" not "Manufacturer"):
//   Supply_Item, location_name, location_id, Manufacture, Manufacture_Number, unit_hand
//
// We canonicalize to a clean internal model at the ingest boundary.
// All ingest goes through PHI detection before mapping (per ADR-005).

import Papa from 'papaparse';
import { checkColumnsForPhi, checkSampleRowsForPhi, type PhiCheckResult } from './phi-detector';

// ─── Raw shape (exactly as USmon writes it) ──────────────────────────────────

export interface UsmonCsvRow {
  Supply_Item: string;
  location_name: string;
  location_id: string;
  Manufacture: string;         // sic — USmon's typo, not "Manufacturer"
  Manufacture_Number: string;  // sic — same typo
  unit_hand: string;           // numeric but parses as string
}

// ─── Canonical internal model ────────────────────────────────────────────────

export interface InventoryItem {
  item_name: string;
  location_name: string;
  location_id: string;
  manufacturer: string;         // canonicalized from Manufacture
  manufacturer_number: string;  // canonicalized from Manufacture_Number
  quantity_on_hand: number;
}

export interface ParseResult {
  ok: boolean;
  items: InventoryItem[];
  phi_check: PhiCheckResult;
  errors: string[];
  warnings: string[];
  source_filename?: string;
  source_columns: string[];
  row_count: number;
}

const EXPECTED_COLUMNS = [
  'Supply_Item',
  'location_name',
  'location_id',
  'Manufacture',
  'Manufacture_Number',
  'unit_hand',
] as const;

// ─── Parser ──────────────────────────────────────────────────────────────────

export function parseUsmonCsv(csvText: string, sourceFilename?: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors.length > 0) {
    errors.push(
      ...parsed.errors.map((e) => `CSV parse error: ${e.message} (row ${e.row ?? '?'})`),
    );
  }

  const columns = parsed.meta.fields ?? [];

  // ── Layer 1: header PHI check ──
  const headerPhi = checkColumnsForPhi(columns);
  if (!headerPhi.passed) {
    return {
      ok: false,
      items: [],
      phi_check: headerPhi,
      errors,
      warnings,
      source_filename: sourceFilename,
      source_columns: columns,
      row_count: 0,
    };
  }

  // ── Layer 2: sample row PHI check ──
  const sample = parsed.data.slice(0, 10);
  const sampleCheck = checkSampleRowsForPhi(sample);
  if (!sampleCheck.passed) {
    return {
      ok: false,
      items: [],
      phi_check: sampleCheck,
      errors,
      warnings,
      source_filename: sourceFilename,
      source_columns: columns,
      row_count: 0,
    };
  }

  // ── Expected-column warning (non-fatal — schema can drift) ──
  const missing = EXPECTED_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    warnings.push(
      `CSV is missing expected columns: ${missing.join(', ')}. ` +
        `Either USmon's export shape changed or a non-Stock-Per-Supply report was uploaded.`,
    );
  }

  // ── Map raw → canonical ──
  const items: InventoryItem[] = [];
  for (const row of parsed.data) {
    const itemName = (row.Supply_Item ?? '').trim();
    if (!itemName) continue; // skip blank rows

    const qtyRaw = (row.unit_hand ?? '').trim();
    const qty = qtyRaw === '' ? 0 : Number.parseInt(qtyRaw, 10);
    if (Number.isNaN(qty)) {
      warnings.push(`Non-numeric unit_hand for "${itemName}": "${qtyRaw}" — treating as 0`);
    }

    items.push({
      item_name: itemName,
      location_name: (row.location_name ?? '').trim(),
      location_id: (row.location_id ?? '').trim(),
      manufacturer: (row.Manufacture ?? '').trim(),
      manufacturer_number: (row.Manufacture_Number ?? '').trim(),
      quantity_on_hand: Number.isNaN(qty) ? 0 : qty,
    });
  }

  return {
    ok: errors.length === 0,
    items,
    phi_check: { passed: true, rejected_columns: [], reason: null, suggestion: null },
    errors,
    warnings,
    source_filename: sourceFilename,
    source_columns: columns,
    row_count: items.length,
  };
}
