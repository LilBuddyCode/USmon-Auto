# ADR-004 SUPERSEDED — see 004-telegram-over-sms.md

This file is a placeholder. The original ADR-004 proposed Twilio SMS.

**Final decision: Telegram Bot API.** See [`004-telegram-over-sms.md`](./004-telegram-over-sms.md) in this same folder.

**Reasoning for the change (logged in [[../../03 - Architecture Decisions (revised)]]):**

- Free vs. Twilio cost
- Zero TCPA / 10DLC overhead
- Native file upload (aunt can DM the CSV to the bot)
- Bidirectional commands (`/status`, `/critical`, etc.)
- Rich content (buttons, formatted text)
- 3-minute setup vs. carrier review

**Action when copying to the real repo:** delete this file. Keep only `004-telegram-over-sms.md`.
