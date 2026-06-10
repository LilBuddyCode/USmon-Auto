# ADR-009: USmon catalog bridge (Stage 2 implementation)

**Status:** Accepted
**Date:** 2026-06-10
**Implements:** Stage 2 of the 3-stage path in [[ADR-008]]

## Context

ADR-008 laid out a 3-stage path that lands the system at the originally-envisioned destination: USmon as source of truth, bot as the alerting + capture layer on top.

- **Stage 1 (Days 3-10):** Bot captures supply requests from techs. Buyer gets a digest. — Built and live.
- **Stage 2 (Days 11-14 + Week 3):** Bot uses accumulated data to generate a USmon Supply Inventory import CSV. Customer pastes once into USmon. USmon catalog becomes real. — **This ADR.**
- **Stage 3 (Month 2-3):** With USmon catalog populated, daily Stock Per Supply CSV export from USmon flows into the existing `/api/ingest` path. — Architecture in place since Day 1; activates when Stage 2 lands.

The customer (the customer) explicitly granted USmon login credentials because she wants to use USmon more, not less. The bot exists to *help her get there* — not to replace USmon.

This ADR documents how Stage 2 is implemented.

## Decision

**Build an export endpoint that emits a CSV in USmon Supply Inventory's exact import format. Surface as a button in the bot. Customer downloads the file and uses USmon's built-in "Import Supply Items from Master Suppliers List" UI to load it.**

We deliberately do NOT:
- Programmatically log into USmon and paste data (storing USmon credentials is a security and compliance concern, and USmon has no API)
- Use Playwright to automate the import (rejected for ingest in ADR-001 — same logic applies here: USmon's UI changes break automation)
- Push directly to a USmon endpoint (USmon has no API surface)

The "generate file, customer pastes it once" pattern is intentional. It's the minimum viable bridge that produces real USmon integration without taking on operational risk.

## Why this matters

Without this bridge, the bot is operationally adjacent to USmon — useful, but disconnected. The 75-90% of IONM companies that use USmon get no benefit from "another tool."

With this bridge:

- Customer's USmon Supply Inventory module gets populated for the first time, reflecting their actual operational catalog
- Customer can begin using USmon's built-in features (count discrepancy reports, hospital invoicing per supply item, expiration tracking) that depend on a real catalog
- The bot demonstrates "we don't replace your system, we make your existing system useful"
- Portfolio narrative shifts from "I built a Telegram bot adjacent to USmon" to "I built a bot that bootstraps USmon's Supply Inventory module with real customer data"

## How the export works

The endpoint `/api/export/usmon-catalog` runs SQL that unions:

1. Every distinct `(item, location)` pair from `reorders` (most authoritative — items actually shipped to a location)
2. Every distinct `(item, location)` pair from `supply_requests` (items reported but not yet ordered — still part of the catalog)

For each pair, we emit one row matching USmon's column shape (per Day 1 scouting of Setup Supplies):

```
Supply_Item,location_name,location_id,Manufacture,Manufacture_Number,unit_hand
```

Key implementation details:

- **Column "Manufacture" honors USmon's existing typo** — see `usmon-csv-parser.ts`. The bot reads this column at ingest and canonicalizes to `manufacturer` internally. The export reverses the canonicalization for round-trip compatibility.
- **`unit_hand` is exported as 0** — we don't track current stock counts in the bot. USmon will update on first count entry from the techs. Catalog is "what items exist," not "how many of each."
- **`location_id` is the `usmon_location_id`** — when the bot first sees a location, it generates an ID (or uses USmon's if it was learned from a previous CSV ingest). This means location identity is preserved if Stage 3 ever feeds USmon CSVs back into the bot.

## How the bot surfaces it

A new menu button: **📤 Export catalog to USmon**

Tap → bot generates the CSV using accumulated data → sends as a file attachment with a caption explaining the 4-step USmon import procedure. The caption also references this ADR and ADR-008 so the operator (or any future auditor) can trace the design intent.

If the bot has fewer than 1 row of accumulated data, it returns a gentle "come back in a week or two" message rather than an empty file.

## ADR-005 (PHI boundary) compliance check

The exported CSV contains: item names, manufacturer text, location names + IDs, supplier-side product codes, quantities. **Zero patient identifiers.** Zero case data. Zero clinical context. The catalog is operational-only, same boundary the rest of the system enforces.

If a future enhancement adds patient-linked data to the export (e.g. "items used per case"), that would violate ADR-005 and must be rejected.

## Stage 3 activation pathway

Once the customer runs the import in USmon and their Supply Inventory catalog is real:

1. Customer exports `Stock Per Supply` CSV from USmon weekly (or more often)
2. Sends CSV to the bot as a file attachment
3. Bot's existing `/api/ingest` route (built Day 1-2) processes it
4. Per-location `daily_counts` get populated with USmon's truth
5. Day 7+ predictive features (recurring-order detection, stockout prediction) layer on top

The Day 1-2 work that "didn't apply" during the Stage 1 phase snaps back into place as the primary data path. This is what ADR-008 promised — and Stage 2 makes it real.

## Trade-offs / open questions

- **Will the customer actually do the import?** This is the adoption gate. The bot's "Export to USmon" button frames it as a one-tap action, and the caption walks her through it. But there's still a ~5-minute USmon UI step she has to do herself. If she doesn't, the bot stays in Stage 1 indefinitely — still useful, but no USmon connection.

- **What if USmon changes the import format?** Then our export breaks until we update. We documented the format in the Day 1 scouting log, but a future USmon UI update could change the column names. Mitigated by: the format is hand-derived from a real export we captured on Day 1; any change would also break the customer's existing export workflow, so she'd flag it.

- **Do we round-trip-test the import?** Not yet. We'd need either (a) a test USmon instance, or (b) the customer to actually run the import and confirm. We'll mark this as the next checkpoint.

## Adoption checkpoint

| Checkpoint | When | Measure |
|---|---|---|
| Bot can export a CSV with real rows | Day 7 | Endpoint returns CSV with non-zero row count |
| Customer downloads the file | When prompted | She taps the export button |
| Customer pastes into USmon successfully | After download | She confirms in chat — bot can ask via a callback button |
| USmon catalog has accurate data | Following count cycle | She can run USmon's Supply Inventory reports against the new catalog |
| Stage 3 activates | Month 2+ | Customer starts exporting Stock Per Supply CSV from USmon and feeding to bot |

## Cross-links

- [[008-capture-first-over-csv-source-of-truth]] — the 3-stage plan this implements
- [[001-csv-over-playwright]] — why we don't automate USmon's UI
- [[005-non-phi-boundary]] — what cannot be in the export
- [[../../BUILD-LOG]] — Day 7 narrative
- [[../../../_data/scouting-log]] — original USmon Setup Supplies UI walkthrough
