# Demo video script (4 minutes)

This is the script for the Day 14 portfolio demo. Record screen + voiceover with QuickTime / OBS / Loom. Target length: **4 minutes**, hard cap **5 minutes**.

The video lives on the repo's README (embedded). Hiring managers watch the video before reading the BUILD-LOG.

---

## Beat 1 — Hook (15 sec)

**On screen:** Open the staging URL `usmon-auto-staging.vercel.app`.

**Say:**

> "This is USmon-Auto. It's a Telegram bot I built in 14 days for a real customer — my aunt, who runs operations at an IONM medical company. It captures supply chain reports from her techs, helps her order from her one supplier, and tracks lot numbers for FDA compliance. By design, zero patient data ever enters the system. Let me show you."

---

## Beat 2 — The dashboard (30 sec)

**On screen:** scroll through the dashboard — hero, stat tiles, recent supply reports table, reorders table, architecture diagram.

**Say:**

> "Public dashboard. Live numbers from Postgres. 12 tables, all operational, zero PHI columns. Right now in the system: 8 items, 3 locations — those are her two techs as ship-to endpoints — 1 supplier, 8 reorders, 2 with lot numbers logged. The bot is live at `t.me/usmon_auto_staging_bot`."

---

## Beat 3 — The capture flow (60 sec)

**On screen:** Open Telegram. Tap on the bot. Type a message.

**Say:**

> "A tech texts the bot in plain English. Watch."

**Type:** `low on parallel pair needles`

**Wait for reply, then say:**

> "Claude Sonnet parsed that in 2 seconds. Logged as `parallel pair needles`, medium urgency, 95% confidence. The bot also surfaced a recurring-order hint — 'you last ordered 17 of these from Primary Supplier on Apr 2' — and gave my aunt a one-tap button to repeat the same order. This is the moment the bot feels smart."

**Tap "🔁 Order 17 like last time".**

**Wait for reply, then say:**

> "Bot created the reorder, linked it back to the supply request, and now offers a Mark Received button. When the box arrives, she taps that."

---

## Beat 4 — The compliance angle (45 sec)

**Tap "📦 Mark received".**

**Say:**

> "Bot asks for the lot number from the box. This is the JCAHO and FDA traceability requirement most IONM companies handle on paper or not at all."

**Type:** `104474`

**Wait for reply, then say:**

> "Logged. If that lot ever gets recalled, the bot will surface every shipment affected in seconds. This is real compliance value — not just convenience automation."

---

## Beat 5 — The PHI gate (30 sec)

**Say:**

> "The hard rule: no patient data ever. Let me try to trick it."

**Type:** `low on dragonfly, used a bunch on patient Smith yesterday`

**Wait for reply, then say:**

> "Rejected at the pre-Claude regex layer. Never even sent to the API. This is enforced at six layers — documentation, schema, parser unit tests, runtime ingest checks, eval fixtures, and lot number validation. The whole reason this project can operate without a HIPAA BAA is that no PHI ever enters the system."

---

## Beat 6 — The USmon bridge (45 sec)

**On screen:** Tap `/menu`, then tap `📤 Export catalog to USmon`.

**Say:**

> "Here's the USmon integration. The original assumption was that we'd ingest USmon's Supply Inventory CSV directly. On Day 2 my aunt told me she doesn't actually use that module — she uses USmon for HIPAA needle counts during procedures, not for stock. The product pivoted. But I kept the original architecture as the long-term destination. The bot now generates a CSV in USmon's exact import format from accumulated data. She pastes it once into USmon's Setup Supplies module, and USmon's catalog goes from empty to fully populated, reflecting her actual operations. The bot bootstraps the legacy system instead of fighting it."

**Show the CSV file in Telegram.**

---

## Beat 7 — The engineering (30 sec)

**On screen:** Click through to the BUILD-LOG, ADRs, EVAL-RESULTS pages on GitHub.

**Say:**

> "Day-by-day BUILD-LOG. Nine architecture decision records documenting trade-offs and the Day 2 pivot. Eighteen-case adversarial eval suite — 100% pass rate after one recalibration round. Five-scenario disaster recovery doc. Auto-deploy script. Everything reproducible in under an hour from this repo. That's the part hiring managers will spend most of their time reading."

---

## Beat 8 — The close (15 sec)

**On screen:** back to the dashboard.

**Say:**

> "Built solo in 14 days. Real customer, real data, real compliance. The link to everything is in the description. Thanks."

---

## Recording checklist

- [ ] Quiet room, no notifications
- [ ] Phone vertical, mirrored to desktop via QuickTime (Mac) or scrcpy (Android)
- [ ] Browser zoom 110-125% for readability
- [ ] Telegram font size: large
- [ ] Cursor highlight enabled in screen recorder
- [ ] No pauses longer than 1 second
- [ ] First take is usually the best — don't over-rehearse
- [ ] Export at 1080p, MP4, drop into the repo at `docs/demo.mp4` (or upload to YouTube and embed)

## Length target

| Beat | Time |
|---|---|
| 1. Hook | 0:00 — 0:15 |
| 2. Dashboard | 0:15 — 0:45 |
| 3. Capture flow | 0:45 — 1:45 |
| 4. Compliance | 1:45 — 2:30 |
| 5. PHI gate | 2:30 — 3:00 |
| 6. USmon bridge | 3:00 — 3:45 |
| 7. Engineering | 3:45 — 4:15 |
| 8. Close | 4:15 — 4:30 |

**Total: 4:30.** If it's running over, trim Beat 7 (engineering) — that's discoverable in the repo.
