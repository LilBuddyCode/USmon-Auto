# ADR-005: Strict non-PHI data boundary

**Status:** Accepted
**Date:** Day 2 of sprint
**Severity:** This is the most important architecture decision in the project.

## Context

USmon is an EHR. The customer (aunt's IONM company) is a HIPAA Covered Entity. Any system that creates, receives, maintains, or transmits Protected Health Information (PHI) on their behalf is a Business Associate and requires a Business Associate Agreement (BAA), HIPAA-compliant infrastructure (encryption, RBAC, audit logs), workforce training, subcontractor BAAs (Anthropic, Twilio, Neon, Vercel), risk assessment, and a Texas Medical Records Privacy Act overlay if relevant.

This project is a 14-day sprint with no BAA in place and no HIPAA infrastructure investment. We cannot legally touch PHI.

## Decision

**This system does not handle PHI. Ever. Under any circumstance.**

Enforcement is implemented at multiple layers:

1. **Documentation layer.** This ADR. The README. The customer-facing intake conversation. The aunt has been told what we will and won't handle.

2. **CSV ingest validation layer.** `lib/phi-detector.ts` runs on every CSV import. It rejects upload if any column header matches:
   - Patient identifiers: `patient_name`, `patient_id`, `mrn`, `medical_record_number`, `case_id`, `case_number`, `accession`, `chart_number`
   - Direct identifiers: `dob`, `date_of_birth`, `ssn`, `social_security`, `phone`, `email`, `address`, `zip`
   - Service-linked dates: `dos`, `date_of_service`, `procedure_date`, `surgery_date`
   - Clinical fields: `diagnosis`, `dx`, `icd`, `cpt`, `procedure_code`, `surgeon`, `provider_npi`

   The check is conservative. False positives are fine. False negatives are not.

3. **Database schema layer.** No tables contain a `patient_*` or `case_id` column. The `daily_counts` table has `item_id`, `location_id`, `date`, `quantity_on_hand`, `quantity_used`. None tie back to patient.

4. **API surface layer.** No endpoint accepts a patient identifier as input. No endpoint returns one as output.

5. **Logging layer.** Logs are sanitized of any field that could match a PHI pattern (defensive — should never trigger if other layers work).

6. **Email-to-ingest path** (if implemented v1.5). Inbound emails are scanned by the PHI detector before any other processing. Reject + delete if PHI detected; alert sender.

## What we handle

Operational data only:

- Supply item SKU codes + names ("ELECTRODE-3M-2222")
- Supply daily counts (on-hand, used today)
- Locations (warehouse names, not patient locations)
- Manufacturer names + prices + lead times
- Order records (PO number, vendor, items, quantities, dates)
- Alert events (when fired, what threshold, to whom)

None of this is PHI.

## What we explicitly do NOT handle

- Patient names, MRN, case IDs, anything that links to a specific patient
- Dates of service tied to identity
- Clinical content (diagnoses, procedures, reports)
- Insurance information
- Chat content from USmon Chat (always patient-linked)
- Anything from the Hospital Invoicing, Insurance Billing, or IDR modules
- Anything that mentions a surgeon, anesthesiologist, hospital department, or specific case

## Status

Accepted. Non-negotiable.

## Consequences

**Positive:**
- Operates legally without a BAA. Massive simplification.
- Customer trust. We can tell the aunt "your patient data never touches our system." That's true and provable.
- Subcontractor simplification. Vercel, Neon, Twilio, Anthropic do not need to be HIPAA-vetted for this use because they never see PHI.
- Engineering simplicity. Encryption + RBAC + audit logs are still good practice but not required at HIPAA grade.
- Generalizable. The same pattern works for any operational layer on top of any EHR.

**Negative:**
- Limits the product. We can never ingest case-level inventory usage that's tied to a specific case ID. That's the most accurate signal for "we used 3 of these in case X, expect similar usage on similar cases." We use the aggregate signal instead (usage per week per SKU per location).
- Customer may inadvertently include PHI in CSV. The PHI detector catches this and rejects the upload with a clear message. Aunt re-exports without those columns.
- Future product may need PHI access. If SB-068 scales and customers want case-level prediction, we cross the bridge with proper BAA + infrastructure. That's a v2 conversation.

## Test

`lib/phi-detector.test.ts` includes:

- Pass: CSV with columns `sku, name, location, on_hand, used_today, manufacturer, expires_at`
- Fail: CSV with `case_id` column
- Fail: CSV with `patient_name` column
- Fail: CSV with `mrn` column
- Fail: CSV with `dob` column
- Fail: CSV with arbitrary alphanumeric column that LOOKS like an identifier (heuristic check)

Tests run on every commit.

## If a PHI breach somehow happens

Documented incident response plan:

1. Immediate: revoke affected user's auth tokens, halt the relevant ingest path
2. Within 1 hour: notify the aunt and her organization's HIPAA officer
3. Within 24 hours: written incident report
4. Defer to her organization's BAA-less third-party incident plan
5. Postmortem committed to `docs/incidents/` (PHI-redacted)

This has not happened and should never happen given the layered enforcement above. But documented in case.

## Related

- ADR-001: CSV ingest is the only data path
- ADR-004: SMS body must not contain patient identifiers (SKU names are non-PHI)
- The HIPAA briefing in `Medical Vertical Opportunity/00 - Spec`
