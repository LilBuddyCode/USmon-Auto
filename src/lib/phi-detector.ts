// src/lib/phi-detector.ts
// Per ADR-005: this is the layered PHI enforcement at CSV-ingest time.
// Conservative bias: false positives (rejecting safe CSVs) are FINE.
// False negatives (letting PHI through) are NOT.

export interface PhiCheckResult {
  passed: boolean;
  rejected_columns: string[];
  reason: string | null;
  suggestion: string | null;
}

// Column-name patterns that ALWAYS indicate PHI. Case-insensitive substring match.
const HARD_BLOCK_PATTERNS: { pattern: string; reason: string }[] = [
  // Patient identifiers
  { pattern: 'patient', reason: 'Patient identifier' },
  { pattern: 'mrn', reason: 'Medical Record Number' },
  { pattern: 'medical_record', reason: 'Medical Record Number' },
  { pattern: 'medicalrecord', reason: 'Medical Record Number' },

  // Case identifiers (link directly to patient via USmon)
  { pattern: 'case_id', reason: 'Case ID (links to patient)' },
  { pattern: 'caseid', reason: 'Case ID' },
  { pattern: 'case_number', reason: 'Case number' },
  { pattern: 'casenumber', reason: 'Case number' },
  { pattern: 'accession', reason: 'Accession number' },
  { pattern: 'chart', reason: 'Chart number' },
  { pattern: 'encounter', reason: 'Encounter identifier' },

  // Direct identifiers
  { pattern: 'ssn', reason: 'Social Security Number' },
  { pattern: 'social_security', reason: 'Social Security Number' },
  { pattern: 'dob', reason: 'Date of birth' },
  { pattern: 'date_of_birth', reason: 'Date of birth' },
  { pattern: 'birth_date', reason: 'Date of birth' },
  { pattern: 'birthdate', reason: 'Date of birth' },

  // Service-linked dates
  { pattern: 'dos', reason: 'Date of Service (links to patient via case)' },
  { pattern: 'date_of_service', reason: 'Date of Service' },
  { pattern: 'service_date', reason: 'Service date' },
  { pattern: 'procedure_date', reason: 'Procedure date (case-linked)' },
  { pattern: 'surgery_date', reason: 'Surgery date (case-linked)' },
  { pattern: 'admission', reason: 'Admission date (case-linked)' },
  { pattern: 'discharge', reason: 'Discharge date (case-linked)' },

  // Clinical fields
  { pattern: 'diagnosis', reason: 'Diagnosis (clinical PHI)' },
  { pattern: 'icd', reason: 'ICD diagnosis code' },
  { pattern: 'cpt', reason: 'CPT procedure code' },
  { pattern: 'procedure_code', reason: 'Procedure code' },
  { pattern: 'procedurecode', reason: 'Procedure code' },

  // Provider identifiers (case-linked)
  { pattern: 'npi', reason: 'National Provider Identifier' },
  { pattern: 'surgeon', reason: 'Surgeon (case-linked)' },
  { pattern: 'physician', reason: 'Physician (case-linked)' },
  { pattern: 'provider_id', reason: 'Provider ID' },

  // Contact info (becomes PHI when linked to anything case-related)
  { pattern: 'patient_phone', reason: 'Patient phone' },
  { pattern: 'patient_email', reason: 'Patient email' },
  { pattern: 'patient_address', reason: 'Patient address' },

  // Insurance (PHI when linked to identity)
  { pattern: 'insurance', reason: 'Insurance information' },
  { pattern: 'payer', reason: 'Payer info (case-linked)' },
  { pattern: 'subscriber', reason: 'Insurance subscriber' },
];

/**
 * Check CSV column headers for PHI patterns.
 * @param columnHeaders raw column names from the CSV first row
 * @returns PhiCheckResult — passed=true means safe to import
 */
export function checkColumnsForPhi(columnHeaders: string[]): PhiCheckResult {
  const rejected: { column: string; reason: string }[] = [];
  for (const raw of columnHeaders) {
    const normalized = raw.toLowerCase().trim().replace(/[\s-]+/g, '_');
    for (const block of HARD_BLOCK_PATTERNS) {
      if (normalized.includes(block.pattern.toLowerCase())) {
        rejected.push({ column: raw, reason: block.reason });
        break; // one match is enough to reject this column
      }
    }
  }

  if (rejected.length === 0) {
    return { passed: true, rejected_columns: [], reason: null, suggestion: null };
  }

  const reasons = rejected.map(r => `${r.column} (${r.reason})`).join(', ');
  return {
    passed: false,
    rejected_columns: rejected.map(r => r.column),
    reason: `CSV contains PHI-pattern columns: ${reasons}`,
    suggestion: 'Re-export from USmon with these columns removed, OR strip them in Excel before upload. This system intentionally cannot accept patient-linked data (per ADR-005).',
  };
}

/**
 * Sample row check — defensive second layer.
 * Looks at a few data rows for values that pattern-match PHI even if headers are clean.
 */
export function checkSampleRowsForPhi(rows: Record<string, string>[]): PhiCheckResult {
  if (rows.length === 0) return { passed: true, rejected_columns: [], reason: null, suggestion: null };
  const sample = rows.slice(0, 10);

  const ssnPattern = /\b\d{3}-?\d{2}-?\d{4}\b/;
  const dobPattern = /\b(19|20)\d{2}[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/;

  const flagged: { column: string; reason: string }[] = [];
  for (const row of sample) {
    for (const [col, val] of Object.entries(row)) {
      if (typeof val !== 'string') continue;
      if (ssnPattern.test(val)) {
        flagged.push({ column: col, reason: 'Value matches SSN pattern' });
      }
      if (dobPattern.test(val) && col.toLowerCase().includes('birth')) {
        flagged.push({ column: col, reason: 'Value matches DOB pattern in birth-related column' });
      }
    }
  }

  if (flagged.length === 0) {
    return { passed: true, rejected_columns: [], reason: null, suggestion: null };
  }

  const seen = Array.from(new Set(flagged.map(f => `${f.column} (${f.reason})`)));
  return {
    passed: false,
    rejected_columns: Array.from(new Set(flagged.map(f => f.column))),
    reason: `Sample values look like PHI: ${seen.join(', ')}`,
    suggestion: 'Strip these columns before re-uploading. This system does not accept patient identifiers.',
  };
}

/**
 * Run both checks. Reject if either fails.
 */
export function runFullPhiCheck(columnHeaders: string[], sampleRows: Record<string, string>[]): PhiCheckResult {
  const headerCheck = checkColumnsForPhi(columnHeaders);
  if (!headerCheck.passed) return headerCheck;
  return checkSampleRowsForPhi(sampleRows);
}
