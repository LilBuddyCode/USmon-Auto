// src/lib/__tests__/usmon-csv-parser.test.ts
// Day 1 smoke tests for the USmon CSV ingest.
// Schema validated against a real export from the customer (2026-06-09):
//   filename: inventory_*.csv
//   path: USmon → Others → Inventory → Inventory Reports → Stock Per Supply → MS Excel (CSV)
//
// Critical guarantees these tests enforce:
//   1. Real USmon column names map cleanly to our canonical model
//   2. Empty data (no rows, headers only) is handled gracefully
//   3. Populated data parses with quantity as integer
//   4. Any PHI-pattern column in a CSV is REJECTED (per ADR-005)
//   5. USmon's "Manufacture" typo is honored on ingest, canonicalized internally

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseUsmonCsv } from '../usmon-csv-parser';

const FIX_DIR = join(__dirname, '..', '..', '..', 'test-fixtures');

const readFixture = (name: string) =>
  readFileSync(join(FIX_DIR, name), 'utf-8');

describe('parseUsmonCsv — real USmon column shape', () => {
  it('accepts the exact column headers from the real Stock Per Supply export', () => {
    const csv = readFixture('usmon-stock-per-supply-empty.csv');
    const result = parseUsmonCsv(csv, 'empty.csv');

    expect(result.phi_check.passed).toBe(true);
    expect(result.source_columns).toEqual([
      'Supply_Item',
      'location_name',
      'location_id',
      'Manufacture',
      'Manufacture_Number',
      'unit_hand',
    ]);
    expect(result.row_count).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('parses populated rows into canonical InventoryItem shape', () => {
    const csv = readFixture('usmon-stock-per-supply-populated.csv');
    const result = parseUsmonCsv(csv, 'populated.csv');

    expect(result.ok).toBe(true);
    expect(result.phi_check.passed).toBe(true);
    expect(result.row_count).toBe(5);

    // Spot check first row — confirms the Manufacture → manufacturer rename works
    expect(result.items[0]).toEqual({
      item_name: 'Dragonfly',
      location_name: 'Operator HQ',
      location_id: 'LOC-001',
      manufacturer: 'Cadwell',          // canonicalized from "Manufacture"
      manufacturer_number: 'DR-100',    // canonicalized from "Manufacture_Number"
      quantity_on_hand: 12,             // parsed to integer from "unit_hand"
    });

    // All quantities must be integers, not strings
    for (const item of result.items) {
      expect(typeof item.quantity_on_hand).toBe('number');
      expect(Number.isInteger(item.quantity_on_hand)).toBe(true);
    }
  });
});

describe('parseUsmonCsv — PHI rejection (ADR-005 enforcement)', () => {
  it('REJECTS any CSV containing a "patient" / "case_id" / "surgeon" column', () => {
    const csv = readFixture('usmon-with-phi-rejection-case.csv');
    const result = parseUsmonCsv(csv, 'has-phi.csv');

    expect(result.ok).toBe(false);
    expect(result.phi_check.passed).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.row_count).toBe(0);

    // All three PHI-pattern columns should be in rejected_columns
    expect(result.phi_check.rejected_columns).toEqual(
      expect.arrayContaining(['patient_name', 'case_id', 'surgeon']),
    );

    // The error message must explain what was rejected
    expect(result.phi_check.reason).toMatch(/PHI/i);
    expect(result.phi_check.suggestion).toMatch(/Re-export/i);
  });

  it('rejects CSV even if the PHI column is mixed in with valid columns', () => {
    const phiInline =
      '"Supply_Item","mrn","unit_hand"\n' +
      '"Dragonfly","FAKE-MRN-001","5"\n';
    const result = parseUsmonCsv(phiInline);

    expect(result.ok).toBe(false);
    expect(result.phi_check.rejected_columns).toContain('mrn');
  });
});

describe('parseUsmonCsv — defensive edge cases', () => {
  it('skips blank rows in the CSV body', () => {
    const csv =
      '"Supply_Item","location_name","location_id","Manufacture","Manufacture_Number","unit_hand"\n' +
      '"Item A","Loc","L1","Mfr","N1","3"\n' +
      '"","","","","",""\n' +
      '"Item B","Loc","L1","Mfr","N2","7"\n';
    const result = parseUsmonCsv(csv);

    expect(result.row_count).toBe(2);
    expect(result.items.map((i) => i.item_name)).toEqual(['Item A', 'Item B']);
  });

  it('warns but does not throw on non-numeric unit_hand', () => {
    const csv =
      '"Supply_Item","location_name","location_id","Manufacture","Manufacture_Number","unit_hand"\n' +
      '"Item A","Loc","L1","Mfr","N1","not-a-number"\n';
    const result = parseUsmonCsv(csv);

    expect(result.items[0].quantity_on_hand).toBe(0);
    expect(result.warnings.some((w) => w.includes('Non-numeric unit_hand'))).toBe(true);
  });
});
