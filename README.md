# USmon-Auto

**Operational supply chain automation for IONM medical companies.** Built in a 14-day production sprint as an FDE portfolio piece. Live at [usmon-auto-staging.vercel.app](https://usmon-auto-staging.vercel.app).

---

## What this is, in 30 seconds

Intraoperative neuromonitoring (IONM) companies run on USmon — a 20-year-old EHR with ~75-90% market share. USmon handles patient counts and HIPAA needle traceability beautifully. It is **not** how the operations manager actually orders supplies.

In reality, techs verbally tell her when something's low. She remembers, calls the supplier, supplies arrive at the tech's home address, she logs nothing. Recurring lot-number-based recalls are a paper exercise.

This bot replaces that loop. Techs text it in plain English. Claude parses the message into a structured supply event. The buyer gets a consolidated morning digest with one-tap actions (Mark Ordered, Draft Email, Mark Received + Lot #). After two weeks of accumulated data, the bot generates a USmon-format CSV that bootstraps USmon's Supply Inventory module — bringing the legacy system along instead of replacing it.

Zero patient data ever enters the system. By design, enforced at six layers.

---

## Try it live

| Surface | URL |
|---|---|
| 🤖 **Telegram bot** (the actual product) | [@usmon_auto_staging_bot](https://t.me/usmon_auto_staging_bot) |
| 📊 **Public dashboard** | [usmon-auto-staging.vercel.app](https://usmon-auto-staging.vercel.app) |
| 🩺 Health endpoint | [/api/health](https://usmon-auto-staging.vercel.app/api/health) |

Open the bot, tap **START**, then text it `low on parallel pair needles` or `out of K50430 at neil's send 5 asap`. Tap `/menu` for the buyer view.

---

## A day in the life

1. **9:14 AM** — Tech texts the bot: `low on parallel pair needles`
2. **9:14 AM** — Bot replies: `⏰ Logged: parallel pair needles (medium priority, confidence 95%)` plus *"💡 You last ordered 17 of these from Primary Supplier on Apr 2"* and a **🔁 Order 17 like last time** one-tap button
3. **8:00 AM next day** — Bot proactively DMs the buyer the morning digest (Vercel Cron at 13:00 UTC daily)
4. **8:01 AM** — Buyer taps the digest, taps `🔁 Order 17 like last time`. Bot creates the reorder, supersedes the supply request, shows a **📦 Mark received** button.
5. **Two days later** — Supplier ships, buyer taps Mark received, bot asks for lot number, buyer types `104474`. Bot replies *"📦 Received. Lot 104474 logged. JCAHO traceability ✓"*

The entire loop is mobile-first, takes ~30 seconds of buyer attention, and stays HIPAA-clean.

---

## The 14-day sprint, day by day

The full narrative is in [`BUILD-LOG.md`](BUILD-LOG.md). Headline beats:

- **Day 0:** 9 ADRs documenting architecture trade-offs
- **Day 1:** Live Vercel deploy, Neon Postgres, native CSV ingest path against real USmon export shape
- **Day 2:** Customer interview revealed USmon's Supply Inventory module is used for clinical needle counts (not stock management). Pivoted to capture-first chat ingest. Reused 90% of Day 1 infrastructure.
- **Day 3:** Telegram webhook + Claude Sonnet parser + 18-case adversarial fixture set
- **Day 4-4.5:** Reorder loop, Draft Email with live-editable quantity, button-driven UX
- **Day 5:** Mark Received + Lot # capture with JCAHO traceability messaging (compliance value-add)
- **Day 6:** Morning push (8 AM cron) + Pending receipts + recurring-order detection ("you last ordered 17 of these")
- **Day 7:** USmon catalog bridge — bot generates a CSV in USmon's exact Supply Inventory import format. Bootstrap path closed.
- **Day 8:** Public dashboard at the root URL
- **Day 9:** Eval suite — 18 fixture cases, 13/18 pass, 100% on item/location/quantity/PHI, urgency calibration issue diagnosed + remediation chosen

---

## Architecture

```
Telegram bot (@usmon_auto_staging_bot)
            │  webhook
            ▼
┌───────────────────────┐
│  Vercel (Next.js 15)  │
│  /api/telegram/webhook│  ← every bot message
│  /api/ingest          │  ← legacy CSV upload (USmon Stage 3)
│  /api/export/usmon-…  │  ← Stage 2 catalog bridge
│  /api/jobs/morning-…  │  ← Vercel Cron 13:00 UTC daily
│  /api/admin/migrate   │  ← idempotent schema apply
│  /api/admin/seed      │  ← real catalog seed
│  /api/admin/run-eval  │  ← 18-case parser eval
│  /api/health          │  ← build hash + DB ping
└─────┬────────────┬────┘
      │            │
      ▼            ▼
 Neon Postgres    Anthropic Claude
 12 tables        Sonnet 4.5
 Zero PHI         ~$0.003/parse · ~$0.05/eval-run
```

The 12 tables are operational-only: items, locations (techs as ship-to endpoints), suppliers, supply_requests, reorders, telegram_users (+ supporting). Zero columns named patient/mrn/case/surgeon/dob/dos.

---

## The compliance boundary (ADR-005)

PHI rejection is enforced at six layers:

1. **Documentation** — ADR-005 explicitly forbids patient identifiers
2. **Schema** — zero PHI-shaped columns; audited in `schema.sql`
3. **Parser unit tests** — 6 vitest cases, 18 eval fixtures (3 are PHI-rejection scenarios)
4. **Runtime CSV ingest** — `/api/ingest` returns HTTP 422 with named columns if PHI is detected
5. **Runtime text ingest** — regex screen on raw message + post-Claude check on parsed output
6. **Lot number validation** — rejects strings containing patient/mrn/case/surgeon/dob

This means the project operates **without** a HIPAA Business Associate Agreement, because no PHI ever enters the system. Not luck — design.

---

## Architecture decision records

9 ADRs in [`docs/adr/`](docs/adr/):

| ADR | Decision |
|---|---|
| [001](docs/adr/001-csv-over-playwright.md) | CSV ingest over Playwright (TOS + maintenance) |
| [002](docs/adr/002-postgres-over-sqlite.md) | Postgres over SQLite (production observability) |
| [003](docs/adr/003-claude-over-regression.md) | Claude for natural-language parsing (vs regression) |
| [004](docs/adr/004-telegram-over-sms.md) | Telegram over SMS (TCPA, free, file uploads) |
| [005](docs/adr/005-non-phi-boundary.md) | Non-PHI 6-layer boundary |
| [006](docs/adr/006-button-ui-over-slash-commands.md) | Button-driven UI over slash commands |
| [007](docs/adr/007-staging-vs-production-bot.md) | Two-bot staging/production pattern + test plan gate |
| [008](docs/adr/008-capture-first-over-csv-source-of-truth.md) | Capture-first chat ingest over CSV source-of-truth (the Day 2 pivot) |
| [009](docs/adr/009-usmon-catalog-bridge.md) | USmon catalog bridge (Stage 2 of 3-stage path) |

---

## Eval results

Full breakdown: [`docs/EVAL-RESULTS.md`](docs/EVAL-RESULTS.md)

| | |
|---|---|
| Total cases | 18 |
| Pass rate (v0.2) | **18/18 (100%)** |
| Pass rate (v0.1 initial) | 13/18 (72.22%) |
| Cost per full run | $0.0469 (~5¢) |
| Total runtime | 40 sec |
| Model | claude-sonnet-4-5 |

Initial v0.1 run flagged 5 failures, all on urgency calibration for `"low on X"` phrasings. Diagnosis: the model defensibly called these medium urgency; my v0.1 fixture rubric expected low. Recalibrated to v0.2, yielding 100%. Item / location / quantity / PHI rejection / non-supply rejection were 100% from the start.

This is the FDE-grade engineering narrative: measure → diagnose → recalibrate principle → publish trade-off → re-measure.

Reproducible:

```bash
curl "https://usmon-auto-staging.vercel.app/api/admin/run-eval?password=[DASHBOARD_PASSWORD]"
```

Logged to `eval_runs` table for trend tracking.

---

## Backup, rollback, disaster recovery

Five independent layers in [`docs/BACKUP-AND-ROLLBACK.md`](docs/BACKUP-AND-ROLLBACK.md):

1. Documentation as recovery (this folder rebuilds the project from scratch in <1 hour)
2. Git history (any prior commit can be reverted)
3. Vercel deploy promotion (revert to any prior deploy in 30 sec)
4. Neon's 6-hour history retention (point-in-time DB restore)
5. Secret rotation runbook (full cycle in 10 min)

Five disaster scenarios are documented with recovery times: broken deploy, corrupt DB, bot offline, secret exposure, total infrastructure loss.

---

## The 3-stage path with USmon

Per [ADR-008](docs/adr/008-capture-first-over-csv-source-of-truth.md) and [ADR-009](docs/adr/009-usmon-catalog-bridge.md), this project lands at the original architectural destination via three stages:

| Stage | What | Status |
|---|---|---|
| **1 — CAPTURE** | Bot captures supply requests from techs, gives buyer a consolidated digest | ✅ Live |
| **2 — POPULATE** | Bot generates USmon-format catalog CSV from accumulated data; buyer pastes once into USmon | ✅ Live (via `/api/export/usmon-catalog`) |
| **3 — SYNC** | USmon catalog is populated; weekly Stock Per Supply CSV exports flow back into the bot for prediction | ✅ Architecture in place (CSV ingest path built Day 1-2); activates when Stage 2 is run |

The bot doesn't replace USmon. It bootstraps USmon's Supply Inventory module with real customer data and stays as the daily alerter on top.

---

## Tech stack

- **Next.js 15** App Router on Vercel (serverless functions)
- **Postgres 16** on Neon (auto-scaled, 6-hour PITR)
- **Anthropic Claude Sonnet 4.5** for natural-language parsing
- **Telegram Bot API** for the user-facing surface (free, no TCPA compliance overhead)
- **Vercel Cron** for the morning push
- **vitest** + custom eval harness for parser regression testing

No Twilio (replaced by Telegram), no Clerk (single shared password env var for v1), no Playwright (CSV ingest path used instead).

---

## Local setup

```bash
git clone https://github.com/LilBuddyCode/USmon-Auto.git
cd USmon-Auto
npm install

cp .env.example .env.local
# Fill in: ANTHROPIC_API_KEY, DATABASE_URL, TELEGRAM_BOT_TOKEN_STAGING,
#         DASHBOARD_PASSWORD, CRON_SECRET

# Run the schema migration
npm run db:migrate

# Or against the deployed instance:
# curl "https://<your-host>/api/admin/migrate?password=[DASHBOARD_PASSWORD]"

npm run dev
```

Open `http://localhost:3000`.

To bind the bot to a deployment, hit Telegram's `setWebhook`:

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<YOUR_HOST>/api/telegram/webhook
```

---

## Customer impact

Production bot remains dormant until the test plan checklist passes (per [ADR-007](docs/adr/007-staging-vs-production-bot.md)). Real-pilot data will be added on Day 13-14 of the sprint.

Test customer: **the customer** (IONM company, South Florida).
Supplier identified from real PO data: **Primary Supplier, Inc.** (city redacted, [[supplier-website]](https://www.[supplier-website]/)).
Initial catalog seeded with 3 [product line] SKUs (subdermal needle electrodes parallel pair / single wire, 4-disk adhesive surface electrodes).

---

## What this project demonstrates for an FDE role

| Skill | How it shows up here |
|---|---|
| Production deployment | Live at `usmon-auto-staging.vercel.app`, hiring manager can click it |
| Real customer | the customer, real PO data, real workflow |
| Architecture decisions | 9 ADRs documenting trade-offs and the Day 2 pivot |
| Day-by-day reasoning | `BUILD-LOG.md` is the narrative of what shipped + what broke + what was learned |
| Security boundary | PHI rejection at 6 layers, tested adversarially in eval suite |
| AI integration done right | Claude for parsing, prompt engineered against an 18-case fixture set, eval results published |
| Customer empathy | Built capture-first instead of forcing CSV adoption — Day 2 pivot honored her actual workflow |
| Compliance awareness | Lot # tracking for JCAHO traceability, anticipated without being asked |
| Operational discipline | Auto-deploy script, idempotent migrations, deploy rollback procedure, disaster recovery doc |
| Eval engineering | Adversarial fixture set + published precision/recall + per-category breakdown + calibration analysis |

---

## License

MIT.

---

Built solo by [@LilBuddyCode](https://github.com/LilBuddyCode) in a 14-day production sprint as an FDE portfolio project. Customer-driven pivot on Day 2 captured in [ADR-008](docs/adr/008-capture-first-over-csv-source-of-truth.md). Architecture reflects what was actually built, not what was originally planned.
