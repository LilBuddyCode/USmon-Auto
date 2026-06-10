# ADR-004: Telegram Bot API over Twilio SMS

**Status:** Accepted (revised from original ADR-004 which proposed SMS)
**Date:** Day 2 of sprint

## Context

When a SKU crosses a stockout-risk threshold, the operations manager needs a notification that arrives within minutes. The notification has to be reliable, mobile-friendly, and require minimal user setup.

Original ADR-004 proposed Twilio SMS. After re-evaluation, Telegram Bot API is the better choice. This document supersedes the SMS proposal.

## Decision

Use **Telegram Bot API** as the primary alert + interaction channel. Web dashboard becomes the secondary surface for deep review + admin.

## Status

Accepted. Telegram is v1's only push channel.

## Consequences

**Positive:**

- **$0 forever.** Telegram Bot API is free, no rate limits at our volume, no per-message cost.
- **No compliance overlay.** Zero TCPA, zero 10DLC registration, zero carrier review. The recipient opts in by messaging the bot once.
- **Rich content.** Bot messages support buttons (inline keyboards), formatted text, file attachments, links, photos. SMS is text-only, 160 chars.
- **Two-way capability.** Aunt can DM the bot a CSV file (the bot ingests it) or type slash commands (`/status`, `/critical`, `/acknowledge`). SMS is one-way push.
- **Multi-user, free.** If we add a second IONM company later, no per-number charges. Add new users by giving them the bot link.
- **Same-day setup.** @BotFather → `/newbot` → token in 3 minutes. No carrier approval.
- **Native mobile notifications.** Aunt's phone already has Telegram. No new app to install.
- **Better dev experience.** node-telegram-bot-api is mature, well-documented, lower friction than Twilio's API.

**Negative:**

- Aunt has to have Telegram installed. (Adoption is ~700M users globally; almost certainly already on her phone, but worth confirming.)
- Slightly higher initial setup for her (one tap to message the bot + `/start`). SMS would arrive without setup, but only if we'd registered 10DLC first.
- Less "professional" feel for some audiences. Mitigation: brand the bot well, use the workflow buttons, make the UX feel intentional. For an IONM company, the operations manager + her ops team are the only users, and they don't care about the channel.
- Less universal than SMS for one-shot delivery to non-prepared recipients. We don't have that use case (aunt is the only user in v1).

**Considered alternatives:**

- **Twilio SMS:** Higher cost, compliance overhead, weaker UX. Rejected.
- **WhatsApp Cloud API:** Free for service messages within 24h windows. BUT requires Meta Business Verification (painful, multi-week), template approvals for non-session messages, and charges per conversation outside the service window. Higher friction than Telegram. Rejected for v1.
- **Email digest only:** Email has hour-scale latency. Not appropriate for stockout urgency.
- **Slack DM:** Aunt's org may not use Slack. Rejected for v1.
- **Voice call via Twilio:** Way too intrusive for the use case. Rejected.

## v1 Telegram bot command surface

| Command | What it does |
|---|---|
| `/start` | Welcome + onboard, captures chat_id |
| `/status` | Top 10 SKUs at risk, sorted by days_until_stockout |
| `/critical` | Only SKUs with days_until_stockout < 3 |
| `/expiring` | Items expiring within 30 days |
| `/help` | List of commands |
| `/dashboard` | Sends link to web dashboard |
| (file upload) | Bot accepts CSV file uploads as DM and ingests them |
| (inline button "Acknowledge") | Marks an alert as seen |

## Alert message template

```
🚨 USmon-Auto — Stockout risk

{{SKU_NAME}} ({{SKU_CODE}})
Days until stockout: {{DAYS}}
On hand: {{ON_HAND}} units
Suggested reorder: {{SUGGESTED}} from {{MANUFACTURER}}

[Acknowledge] [View on Dashboard]
```

Telegram parses Markdown / HTML. Buttons are inline. Much richer than 160-char SMS.

## Production upgrade path documented for v2

The README documents three v2 ingest automation options for hiring-manager review:

1. Windows scheduled task → exports CSV nightly → emails to `ingest@usmon-auto.vercel.app`
2. Playwright headless export (controlled — runs at 2am, downloads CSV only, on her machine)
3. Direct USmon partnership

For v1: aunt either uploads CSV via web OR sends it to the bot. Both work.

## Related

- ADR-001: CSV ingest is the data source (Telegram doesn't change this)
- ADR-005: Non-PHI boundary still applies (bot messages contain SKU names + quantities, never patient data)
- This ADR REPLACES the prior ADR-004 (SMS via Twilio). Delete the SMS ADR file before commit.
