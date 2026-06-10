# ADR-008: Capture-first chat ingest over CSV source-of-truth (Stage 1 of 3)

**Status:** Accepted
**Date:** 2026-06-09
**Supersedes:** Partially supersedes ADR-001 (CSV over Playwright) — see "Relationship to ADR-001" below

## Context

The first two days of this project shipped a complete CSV-ingest pipeline against
USmon's Supply Inventory module: live deploy, parser with 6 passing vitest cases
against the real export shape, runtime PHI rejection, atomic Postgres insert,
Telegram webhook receiving CSV file uploads and replying with row counts.

On Day 2 we asked the customer (operations manager at an IONM company, the test
customer for the entire project) how she actually handles supply inventory.
Her reply rewrote our understanding:

> "I do nothing with this feature on USmon as far as keeping or tracking
> inventory. We really use it for needle count (keeping up with how many we
> placed and removed) — it's a HIPAA thing. Needle counts for accountability!
> But I am the one that orders supplies. They just tell me when they're getting
> low and I call my supplier and she gets it out the same day."

Three facts changed:

1. The USmon Supply Inventory module is used for clinical needle counting
   (JCAHO surgical safety requirement), not stock management.
2. Her real workflow is verbal triage: techs tell her, she calls her supplier.
3. She has Telegram on her phone only, not her laptop. She wants to use USmon
   for inventory — but doesn't yet.

The original Day 1-2 architecture targeted a customer who already used USmon
Supply Inventory and exported CSVs from it. That customer does not currently
exist for us, but she wants to become that customer.

## Decision

**Adopt a 3-stage path that lands at the originally-envisioned destination.**

### Stage 1 — CAPTURE (Days 3-10 of the sprint)

The bot accepts free-text supply reports from anyone DMing it (initially the customer,
then her two techs after onboarding). Claude Sonnet 4.6 parses each unstructured
message into a structured `supply_request` event. the customer gets a consolidated
morning digest of items reported low across her team. She calls her supplier
once instead of three times. Bot logs each "marked ordered" action with timestamp.

Behavior change: tiny. Techs text the bot the same words they would have texted
the customer. the customer opens the bot once a day instead of relying on memory.

### Stage 2 — POPULATE (Days 11-14 + post-portfolio week 3)

After ~2 weeks of accumulated `supply_request` events, the bot has learned the
customer's actual operational catalog. It generates a USmon-Supply-Inventory-
import-formatted CSV. The customer pastes it into USmon Setup Supplies once.
USmon now has accurate Supply Inventory catalog data, not placeholder rows.

### Stage 3 — SYNC (post-portfolio, month 2-3)

With USmon Supply Inventory populated, the original Day 1-2 plan activates as
the long-term primary data path. Weekly Stock Per Supply CSV export from USmon
flows through the existing `/api/ingest` endpoint, the existing parser, the
existing PHI gate, into the existing `daily_counts` table. Capture-first becomes
a fallback channel for edge cases (out-of-band reports, items USmon doesn't
track, location-level granularity USmon lacks).

## Consequences

### Positive

- **All Day 1-2 infrastructure is reused.** The Vercel deploy, Neon Postgres,
  Telegram webhook, Anthropic API integration, PHI detector, 7 prior ADRs,
  test fixtures, and 6 passing parser tests all carry forward without rework.
- **The original CSV ingest path stays live and tested.** It moves from primary
  to fallback, then back to primary at Stage 3.
- **Customer-driven design.** The Stage 1 capture flow matches the workflow
  she actually has, not the workflow we wished she had. Adoption risk drops
  to near zero.
- **Faster time-to-value.** First useful output (consolidated morning digest)
  ships in Day 3-4, not Day 7. The customer has a working tool before any
  prediction work is needed.
- **Stronger portfolio narrative.** Hiring managers reading the BUILD-LOG see
  a documented customer-driven adaptation, not a build-against-spec project.
- **Smaller team scope.** Customer's team is two techs plus herself. The bot
  is designed for 3 users in v1, scales to N later but doesn't pretend to.

### Negative

- **Adds dependency on Claude parse accuracy.** Tech messages are unstructured
  — "low dragonfly", "out of needles at lakeside", "need 20 more pads". Parse
  quality matters. Day 9 eval suite will measure precision/recall against a
  hand-labeled fixture set; CI gates on it from Day 10.
- **The CSV path doesn't get used in the customer demo.** It still gets exercised
  in tests (vitest fixtures, deployed-endpoint smoke tests), but the portfolio
  demo video centers Stage 1 capture, not the original ingest.
- **Stage 2 / Stage 3 not fully built within the 14-day window.** The bot will
  contain the Stage 2 catalog-export generator, but Stage 3 (USmon as primary
  data path) is roadmapped, not demonstrated. Mitigated by Day 1-2 work having
  already demonstrated Stage 3's technical feasibility against real data.

### Neutral

- Two storage tables are added (`supply_requests`, `reorders`). The existing
  schema continues to work; this is additive.
- The Telegram webhook gains a `handleText` branch parallel to its existing
  `handleDocument` branch. Both paths feed into the canonical `items`,
  `locations`, and `daily_counts` model.

## Alternatives considered

### Alternative 1: Stay the original course; coach the customer into using USmon Supply Inventory first.

Rejected. Asking a busy operations manager to adopt an unused module in a
legacy EHR before our system provides any value violates the "no value before
adoption" principle. The capture-first bot delivers value on Day 3.

### Alternative 2: Build a different EHR integration (e.g., a different USmon module).

Rejected. The pain isn't "USmon doesn't track inventory." The pain is "techs
report verbally and the customer forgets things between calls." That pain doesn't live
inside USmon at all. Solving it with another USmon module would over-engineer
the wrong problem.

### Alternative 3: Pure standalone product, abandon USmon entirely.

Rejected. The customer explicitly wants to use USmon eventually (she granted
access for exactly this reason). The original Day 1-2 ingest pipeline retains
its value as the long-term destination. Discarding it would discard a working
PHI gate, a working parser against real EHR data, and a working migration
endpoint — all of which are portfolio-grade demonstrations.

## Relationship to ADR-001

ADR-001 chose CSV-over-Playwright as the integration mechanism for USmon Supply
Inventory data. That decision still holds — when USmon is populated (Stage 3),
CSV export is the cleanest integration path.

ADR-008 narrows ADR-001's scope: CSV is the right mechanism for the eventual
canonical flow, but it is not the right mechanism for Day 1 customer value.

## Adoption checkpoints

| Checkpoint | When | Measure |
|---|---|---|
| Capture is being used | Day 5-6 | At least 5 `supply_request` rows in DB from real users |
| Digest is read daily | Day 7-10 | Telegram `getUpdates` shows `/menu` or `📋 Today` tapped ≥ 3 days in last 5 |
| Stage 2 generation works | Day 11-12 | Bot can emit a USmon-format CSV that pastes cleanly into Setup Supplies (validated against the real Setup Supplies layout we scouted) |
| Stage 3 reactivation roadmap | Day 14 | README documents how the Stage 1 capture path retires once USmon catalog is real |

## Cross-links

- [[001-csv-over-playwright]]
- [[005-non-phi-boundary]] — still the floor; capture messages must also be PHI-safe
- [[../../Cowork Sessions/2026-06-09b — Day 2 Customer Discovery Pivot]] — context for this ADR
