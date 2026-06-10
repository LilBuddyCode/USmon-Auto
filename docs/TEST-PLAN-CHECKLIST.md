# Test plan checklist — staging-to-production gate

Per [ADR-007](adr/007-staging-vs-production-bot.md), the production bot stays
dormant until every check below passes against the staging bot. The customer
(the customer) never sees a bug because she only meets the bot after this checklist
runs green.

This document is the operational gate. Anyone running the rollout works
through it in order, ticking boxes as they pass.

---

## Pre-flight (5 min)

- [ ] `usmon-auto-staging.vercel.app/api/health` returns 200 with `db.ok = true`
- [ ] `usmon-auto-staging.vercel.app/` (dashboard) loads and shows live stat tiles
- [ ] Latest deploy on Vercel is **Ready** (not Error, not Building)
- [ ] GitHub `main` HEAD matches the deployed commit SHA on `/api/health`
- [ ] `eval_runs` table has at least one entry from the last 24h with `precision_score >= 0.95`

If any pre-flight fails: stop, investigate, do not proceed.

---

## Conversational paths (10 min, drive via the staging bot)

### Path A — buyer-side menu flow

- [ ] Send `/menu` → bot replies with welcome message + 4-row inline keyboard
- [ ] Tap `📋 Today's list` → bot returns either a non-empty digest or the "all quiet" message
- [ ] Tap `📦 Pending receipts` → bot returns either a non-empty list or "all caught up"
- [ ] Tap `📥 Recent reports` → bot returns last 5 reports or "no reports yet"
- [ ] Tap `📊 Status` → counts render without error
- [ ] Tap `📞 Suppliers` → list renders (at least Primary Supplier)
- [ ] Tap `❓ Help` → help text renders
- [ ] Tap `📤 Export catalog to USmon` → bot sends a `.csv` file attachment with caption

### Path B — tech-side text capture

- [ ] Send `low on parallel pair needles` → bot logs the report with `medium` urgency + buttons
- [ ] Send `out of K50430 at neil's send 5 asap` → bot logs with `high` urgency + qty 5 + location
- [ ] Tap the `🔁 Order N like last time` button (if it appears) → bot creates a reorder
- [ ] Tap `✅ Mark ordered` on a fresh request → bot confirms + shows `📦 Mark received` button
- [ ] Tap `📦 Mark received` → bot asks for lot number
- [ ] Reply with `104474` → bot confirms `JCAHO traceability ✓`
- [ ] Reply with `skip` to a different Mark Received prompt → bot completes without lot, warns gently
- [ ] Reply with `/menu` during a pending lot prompt → bot cancels pending state, shows main menu

### Path C — Draft Email flow

- [ ] Tap `📧 Draft email` on a fresh request → bot returns email body in code block + qty buttons
- [ ] Tap `➕ 5` twice → message updates in place, qty increases by 10
- [ ] Tap `➖ 1` once → qty decreases by 1
- [ ] Tap `✅ Sent it — mark ordered` → bot creates reorder with the *edited* qty

---

## Adversarial safety paths (5 min)

### PHI rejection — must reject every input below

- [ ] Send `low on dragonfly, used a bunch on patient Smith yesterday` → bot replies with `🚫 PHI signal detected` + asks to rephrase
- [ ] Send `ran out of needles for MRN 9912334` → bot replies with PHI rejection mentioning MRN
- [ ] Send `Dr. Johnson did 4 cases today, low on probes` → bot replies with PHI rejection mentioning Surgeon

### CSV ingest backup path (optional sanity)

- [ ] Upload `test-fixtures/usmon-stock-per-supply-empty.csv` as a file → bot replies `0 data rows`
- [ ] Upload `test-fixtures/usmon-with-phi-rejection-case.csv` → bot rejects with named PHI columns

---

## Cron + scheduled jobs (5 min)

- [ ] `CRON_SECRET` is set in Vercel env vars
- [ ] Manually fire `curl "https://usmon-auto-staging.vercel.app/api/jobs/morning-digest?password=[DASHBOARD_PASSWORD]"` → returns `ok:true, users_pushed: ≥1`
- [ ] Confirm digest DM landed in operator's Telegram chat with the expected format
- [ ] Verify next scheduled cron fire time in Vercel (Settings → Cron Jobs) is within 24h

---

## Eval suite (5 min)

- [ ] Fire `curl "https://usmon-auto-staging.vercel.app/api/admin/run-eval?password=[DASHBOARD_PASSWORD]"`
- [ ] Response: `pass_rate >= 0.95` (current baseline: 18/18, 100%)
- [ ] No category has `pass < total / 2` (no category should be majority-failing)
- [ ] `eval_runs` row was inserted with the new pass_rate

---

## Production bot creation (only if all above pass)

- [ ] Open Telegram, message `@BotFather`, run `/newbot`
- [ ] Bot display name: `USmon Auto`
- [ ] Bot username: `usmon_auto_bot` (or first available variant)
- [ ] Save the token in `usmon-auto-keys.txt` as `TELEGRAM_BOT_TOKEN_PRODUCTION`
- [ ] In Vercel env vars: add `TELEGRAM_BOT_TOKEN_PRODUCTION` with the token value
- [ ] Set webhook for production bot:
  ```
  https://api.telegram.org/bot<PROD_TOKEN>/setWebhook?url=https://usmon-auto-staging.vercel.app/api/telegram/webhook
  ```
  (Production initially shares the deploy with staging; later we can split deployments per ADR-007.)
- [ ] Confirm via `getWebhookInfo` that the webhook URL is set

---

## Production bot smoke test (5 min)

Repeat the buyer-side menu flow (Path A above) against the **production** bot. The endpoints differ in routing (bot token check uses `APP_ENV` to pick the right token), so a few minutes of mirror-tests catch any prod-only config drift.

- [ ] `/menu` on production bot renders full keyboard
- [ ] One supply report → bot logs and confirms
- [ ] One Mark Ordered → bot creates reorder
- [ ] One Mark Received with lot → bot confirms JCAHO traceability

---

## Customer handoff (the actual rollout)

- [ ] Send the customer the [`the customer - Quickstart.md`](../../the customer%20-%20Quickstart.md) doc + the production bot link
- [ ] Confirm she has Telegram on her phone
- [ ] Get her telegram_user_id by asking her to send `/start` first, then read it from `telegram_users` table
- [ ] Update her `role` column from `tech` (the default) to `buyer`
- [ ] Send tech onboarding to Neil + tech #2 (the [`Tech - Quickstart.md`](../../Tech%20-%20Quickstart.md) doc, planned for Day 11)
- [ ] Monitor for 24 hours: watch `/api/health`, check Vercel function logs, watch for any error responses in Telegram

---

## Rollback plan

If anything breaks in production:

1. **Same-day rollback:** revoke the prod bot token via @BotFather (`/revoke` → `/token`). Old token is dead. Bot stops responding immediately. Customer hits no bug because the bot is silent rather than wrong.
2. **Deploy issue:** Vercel deploy promotion to the last good deploy (~30 sec) — see [`BACKUP-AND-ROLLBACK.md`](BACKUP-AND-ROLLBACK.md) Scenario A.
3. **DB corruption:** Neon point-in-time restore to 6-hour history.
4. **Secret leaked:** rotate via the rotation runbook in [`BACKUP-AND-ROLLBACK.md`](BACKUP-AND-ROLLBACK.md).

The staging bot stays running through any rollback so we can debug without touching production.

---

## Sign-off

| Item | Date | Notes |
|---|---|---|
| Checklist completed | _____________ | Operator: _____________ |
| Production bot live | _____________ | Bot handle: @_____________ |
| First customer message received | _____________ | From: _____________ |
| 24h post-rollout review | _____________ | Issues: _____________ |

---

This checklist is intentionally boring. Boring is the goal. Rolling out a customer-facing tool is a high-stakes event; the discipline is to make it boring so the operator can focus on the customer relationship, not the technical surprise.

See also:
- [ADR-007](adr/007-staging-vs-production-bot.md) — the two-bot pattern this checklist gates
- [BACKUP-AND-ROLLBACK.md](BACKUP-AND-ROLLBACK.md) — recovery procedures if any scenario fires
- [EVAL-RESULTS.md](EVAL-RESULTS.md) — pass-rate baseline that pre-flight reads against
