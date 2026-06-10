# ADR-002: Postgres on Neon over SQLite

**Status:** Accepted
**Date:** Day 2 of sprint

## Context

We need a data store for:

- Supply items + their daily counts
- Manufacturers + their pricing
- Orders + receiving history
- Alert events (when fired, to whom, what threshold)
- Prediction outputs (for eval suite + drift detection)
- Eval results (regression tests across historical data)

Two reasonable choices: SQLite (file-based, dead simple) or Postgres (network database, more capable).

## Decision

Use **Postgres on Neon's free tier**.

## Status

Accepted.

## Consequences

**Positive:**
- Production-grade. Multi-connection. ACID. Real backups.
- Neon's free tier is generous (0.5 GB storage, 100 hours compute/month). Plenty for v1.
- Observability. Neon dashboard shows queries, connections, errors. SQLite would require us to instrument everything by hand.
- Future-ready. If this pilot becomes SB-068 multi-tenant SaaS, we already have the right tool.
- Plays well with serverless. Next.js + Vercel + Neon is a well-trodden path.
- JSON columns. We can store Claude's full prediction payload (with reasoning) in a JSONB column. SQLite supports JSON but Postgres is cleaner.

**Negative:**
- Slight setup overhead vs. SQLite (3 min on neon.tech).
- Cold-start latency on Neon free tier (first query after idle takes ~500ms). Mitigation: warm-up pings in the dashboard load, or upgrade if pilot scales.
- We could be over-engineering for a 14-day pilot. Counter: the pilot is judged as production-quality work for FDE applications. Production tools belong here.

**Considered alternatives:**

- **SQLite:** Dead simple, file-based, zero infrastructure. Rejected for production-quality demonstration.
- **Supabase:** Similar shape to Neon. Adds RLS + auth + storage. Worth considering. Neon chosen because we already have Clerk for auth and don't need RLS for single-tenant v1.
- **Self-hosted Postgres:** Maintenance burden too high for 14 days.

## Related

- ADR-003: Claude over regression (prediction output JSONB lives here)
