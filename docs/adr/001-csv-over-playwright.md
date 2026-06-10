# ADR-001: CSV ingest over Playwright

**Status:** Accepted
**Date:** Day 2 of sprint
**Decision makers:** Duran Snoddy

## Context

USmon does not publish a public API. Integration with the platform requires one of:

1. Playwright browser automation on the web UI at `usmon.com/db/index.jsp`
2. Mobile app reverse engineering (Android + iOS USMON Lite)
3. CSV export from the platform (manual user action) parsed by us
4. Email parsing of USmon-generated notifications
5. Paying USmon for their Custom Workflow Creation service
6. A parallel system that doesn't read from USmon at all

We need to read supply inventory data into our companion tool to deliver predictive reordering, supplier price comparison, and expiration alerts.

## Decision

Use **CSV export + parser**. User exports CSV from USmon's Supply Inventory module on a manual or scheduled cadence and drops it in our app (upload form OR email-to-system address). We parse it server-side and upsert to Postgres.

## Status

Accepted.

## Consequences

**Positive:**
- No Terms of Service violation. USmon's TOS likely prohibits automated browser scraping. CSV export is a sanctioned export path.
- Lowest maintenance burden. UI changes don't break us. CSV column changes break us, but those are rarer and recoverable.
- HIPAA-friendly. CSV export is a controlled action by the user; we never silently lift data from their account.
- Fastest path to v1. We're focused on the value layer (prediction + alerts), not on integration plumbing.
- Generalizable. Same pattern works for any niche EHR with CSV export.

**Negative:**
- Real-time-ness. CSV imports happen on user cadence (probably daily). Inventory data lags by up to a day. Acceptable for stockout prediction; not acceptable for emergency case-time operations.
- Manual upload friction. User has to remember to export. Mitigation: SMS them a reminder Friday morning OR set up email-to-ingest so they email the CSV to a system address.
- No write-back to USmon. We can SUGGEST a reorder but we can't fire the order in USmon directly. User has to go back to USmon to action it.

**Considered alternatives:**

- **Playwright on UI:** Higher quality data freshness, but high TOS + maintenance risk. Rejected.
- **Mobile app reverse engineering:** Possible but legally gray and brittle. Rejected.
- **Email parsing of USmon notifications:** Useful as a SECONDARY signal (low-stock alerts USmon sends out). Worth adding in v1.5 but not the primary ingest. Deferred.
- **Pay USmon for custom workflow:** Competing on their turf; expensive. Rejected.

## Related

- ADR-005: Non-PHI data boundary (CSV ingest layer enforces this)
