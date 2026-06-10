# ADR-007: Two-bot deployment (staging vs production)

**Status:** Accepted
**Date:** Day 2 of sprint

## Context

The production customer (aunt) cannot be the test environment. A buggy first impression destroys trust permanently. Bot-style interfaces are particularly bug-prone because state lives across messages, callbacks can fire out-of-order, file uploads can fail mid-stream, and Telegram's webhook delivery has retries that can cause duplicate processing.

We need a way to test the bot completely without ever exposing aunt to a half-baked interaction.

## Decision

**Two bots, two Telegram tokens, two environments, same codebase.**

- **STAGING bot** — `@USmonAutoStagingBot` (or similar). Connected to Duran's personal Telegram account only. Used for development testing.
- **PRODUCTION bot** — `@USmonAutoBot`. Connected to aunt + any other approved users. Used only after staging is bulletproof.

Both bots are created via @BotFather. Both use the same codebase deployed to either the same Vercel deployment with environment switching, or to two separate Vercel deployments. Choice depends on cost / simplicity.

**Recommended: two Vercel deployments.**
- `usmon-auto-staging.vercel.app` — STAGING_BOT_TOKEN + DATABASE_URL_STAGING
- `usmon-auto.vercel.app` — PROD_BOT_TOKEN + DATABASE_URL_PROD

Why two deployments: cleaner separation. Staging gets all the breaking changes. Production gets only what survived staging. Hiring managers see "staging-first deploy discipline" — production-engineering signal.

## Status

Accepted.

## Consequences

**Positive:**
- Aunt never sees a bug from us. Period.
- Duran can break the staging bot freely. Try every edge case. Test every flow.
- Each release follows the staging-first pattern. ADR signals production discipline.
- Staging has its own database, so bad test data never pollutes the real customer data.
- Easy to demo to hiring managers: "here's the staging environment where I tested everything before customer rollout."

**Negative:**
- Two Vercel projects, two Neon databases, two bot tokens. Slight extra account management.
- Free tiers cover both, but we have to remember to NOT confuse staging URL with production when sharing.
- Telegram webhook secret is per-bot, so we manage two.

**Considered alternatives:**

- **One bot, environment variable switch:** Same bot serves both staging and production behavior based on chat_id whitelist. Rejected because Telegram makes the bot identity globally visible — same bot in two contexts is confusing.
- **Polling instead of webhook for staging:** Polling is simpler for local dev (no public URL needed). We can use polling locally and webhook for production. Both fine. Recommended: webhook for both staging and prod for parity.
- **No staging, just test locally:** Rejected. Local testing misses webhook timing, Vercel cold-start behavior, real Telegram delivery edge cases.

## Test plan (Week 1, before aunt sees anything)

This list is the gate between Day 1 (staging deployed) and Day 7 (aunt sees the production bot).

**Functional tests (every button, every flow):**

- [ ] `/start` and `/menu` both show the main menu
- [ ] Every main menu button responds correctly
- [ ] Every sub-menu button responds correctly
- [ ] "Back to Menu" buttons return to home
- [ ] CSV upload via file attachment ingests successfully
- [ ] CSV with PHI columns is rejected with clear error message
- [ ] CSV that's malformed is rejected with clear error message
- [ ] Empty CSV is rejected with clear error message
- [ ] Status returns top 10 SKUs sorted correctly
- [ ] Critical filter only shows < 3 day predictions
- [ ] Expiring filter has 30/60/90 day sub-options that work
- [ ] Dashboard link button opens dashboard
- [ ] Help button shows clear instructions
- [ ] Alert message renders correctly with all expected info
- [ ] "Mark Reordered" button updates the database
- [ ] "Snooze 24h" button suppresses further alerts for that SKU

**Edge cases:**

- [ ] What happens when Anthropic API errors? (graceful fallback or clear error)
- [ ] What happens when Postgres is unreachable? (clear error, no data loss)
- [ ] What happens when two CSVs upload simultaneously? (no race, idempotent)
- [ ] What happens when an alert fires while user is mid-conversation? (doesn't interrupt context)
- [ ] What happens when a button is pressed twice quickly? (idempotent, no double-action)
- [ ] What happens to alerts when the bot is restarted? (queued, retried, or logged for manual review)
- [ ] What happens when an SKU has zero historical data? (don't predict, mark "insufficient data")
- [ ] What happens when prediction returns nonsense? (eval suite catches; fallback message to user)

**User trust tests:**

- [ ] No "undefined" or "null" text appears anywhere
- [ ] All numbers formatted with commas (1,234 not 1234)
- [ ] All dates formatted human-readable
- [ ] Error messages are friendly, not technical
- [ ] Loading states show when something is processing
- [ ] No technical jargon ("SQL error", "stack trace") leaks to the user

**Performance tests:**

- [ ] Status button responds within 2 seconds
- [ ] CSV ingest for 200 SKUs completes within 30 seconds
- [ ] Prediction for 200 SKUs completes within 60 seconds
- [ ] Dashboard loads within 2 seconds on cold start

When all checkboxes pass, the production bot link goes to aunt. Until then, only Duran's account is on the staging bot.

## Related

- ADR-004: Telegram Bot API (this is the deployment discipline for it)
- ADR-006: Button-driven UI (every button on this list must be tested)
- BUILD-LOG.md: each day's testing journal entries
