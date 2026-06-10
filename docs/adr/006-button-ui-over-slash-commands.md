# ADR-006: Button-driven UI, single `/menu` safety command

**Status:** Accepted
**Date:** Day 2 of sprint
**Decision makers:** Duran Snoddy

## Context

The target user is an operations manager at an IONM company. She is comfortable with smartphone apps and Telegram, but is new to bot-style interfaces. She has not used a chat bot with slash commands before.

Original ADR-004 (Telegram) proposed a command surface with `/status`, `/critical`, `/expiring`, `/help`, `/dashboard`, and `/start`. Six commands she would have to remember and type accurately.

User testing concern raised by Duran: slash commands are error-prone for new bot users. Typos, capitalization mistakes, and forgetting which command does what create friction and reduce adoption.

## Decision

**Button-driven UI only.**

Inline keyboards (buttons attached to messages) drive every interaction. The bot replies to button taps via callback_query handlers, not text parsing.

**One safety command: `/menu`.** This re-displays the main menu in case the user scrolled past it, started a fresh conversation, or got lost. It is the only command the user is ever told about.

`/start` is also wired (Telegram convention for first-touch onboarding) but it just calls the same handler as `/menu`.

## UI Design

### Main menu (sent on /start or /menu)

```
🏥 USmon-Auto

What would you like to see?

[📊 Status]   [🚨 Critical]
[⏰ Expiring] [📤 Upload CSV]
[📈 Dashboard] [❓ Help]
```

### Button → response patterns

**📊 Status:**
> Top 10 SKUs at stockout risk, sorted by days_until_stockout
>
> 1. ELECTRODE-3M-2222 — 4 days
> 2. PROBE-GENERIC-SM — 6 days
> ... (8 more)
>
> [🚨 Show Only Critical] [📤 Upload Fresh Data]
> [← Back to Menu]

**🚨 Critical:**
> 3 SKUs at risk of stockout within 3 days
>
> 1. ELECTRODE-3M-2222 — 1.5 days, on-hand 12, suggest reorder 50
>    [Mark Reordered]  [Snooze 24h]
> 2. ...
>
> [← Back to Menu]

**⏰ Expiring:**
> Items expiring within 30 / 60 / 90 days
>
> [📅 30 Days] [📅 60 Days] [📅 90 Days]
> [← Back to Menu]

**📤 Upload CSV:**
> Send me your USmon Supply Inventory CSV export as a file attachment in this chat. I'll let you know when it's processed.
>
> [❓ How to Export from USmon] [← Back to Menu]

**📈 Dashboard:**
> Open the full dashboard:
> https://usmon-auto.vercel.app
>
> Password: (share out of band)
>
> [← Back to Menu]

**❓ Help:**
> Quick guide:
> - Tap a button to see info
> - Send me a CSV file to update inventory
> - I'll alert you when something runs low
> - Type /menu anytime to come back here
>
> [← Back to Menu]

### Alert message pattern

When an alert fires (predicted stockout, expiring item):

```
🚨 USmon-Auto — Stockout risk

ELECTRODE-3M-2222
Days until stockout: 2.5
On hand: 18 units
Suggested reorder: 50 units
Best price: Henry Schein at $4.10/unit

[✅ Mark Reordered] [⏸️ Snooze 24h]
[📈 View on Dashboard]
```

Every alert is actionable from the message itself. No "go open this other thing."

## Status

Accepted.

## Consequences

**Positive:**
- Zero typing errors. Tap = correct action.
- Discoverable. User sees all available options at once.
- Better for new bot users. Onboarding friction drops to zero.
- Action embedded in messages. "Mark Reordered" on the alert itself, not a separate screen.
- Mobile-native. Buttons render beautifully on Telegram mobile.
- Same architecture supports voice input later (Telegram voice → transcribe → mapped to action) without UI changes.

**Negative:**
- Slightly more state management. The bot has to remember "what menu is this user in" via callback_query data. Not hard, just one more concern.
- Power users might miss having commands. Mitigation: `/menu` works from anywhere as a safety command. If we ever need more commands for power users, we add them without breaking the button flow.
- Slight extra dev work compared to "just match these strings to actions." Worth it.

**Considered alternatives:**

- **Slash commands only:** Original ADR-004 proposal. Rejected for user-error reasons.
- **Slash commands AND buttons (redundant):** Rejected as inconsistent ("which is the real way to do it?").
- **Reply keyboards (replaces the user's keyboard with our buttons):** Considered. They persist between messages so they're "always there." Trade-off: they take screen space and conflict with the ability to type free text (we still want her to upload files, send `/menu`, etc.). Inline keyboards (attached to messages) are the right balance.
- **Web app inside Telegram (Mini App):** Bigger lift. Better for v2 if adoption proves out. Deferred.

## Implementation note

Use `node-telegram-bot-api` with `polling` or `webhook` mode. Callback queries arrive as separate events. Route via a single dispatcher in `src/bot/dispatcher.ts`:

```typescript
bot.on('callback_query', async (q) => {
  const action = q.data;  // matches what we set on the button
  switch (action) {
    case 'menu': return showMainMenu(q);
    case 'status': return showStatus(q);
    case 'critical': return showCritical(q);
    // ... etc
  }
});
```

## Related

- ADR-004: Telegram Bot API (this expands on the UX layer)
- ADR-007: Staging vs production bot (this UI gets tested on staging before aunt sees it)
