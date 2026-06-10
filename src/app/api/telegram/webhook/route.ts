// src/app/api/telegram/webhook/route.ts
// Receives every message from @usmon_auto_staging_bot.
//
// Per ADR-008 Stage 1: text messages are now treated as free-text supply
// reports. Document uploads (CSV) remain as a backup ingest path.
//
// Branches:
//   /menu, /start                    → welcome + main menu
//   plain text                       → parse as supply report, save, reply
//   callback_query (button click)    → handle button action
//   document (CSV upload)            → legacy ingest path
//
// Per ADR-006: button-driven UI. Only /menu and /start exposed as commands.
// Per ADR-007: this is the STAGING bot. Production bot is dormant until Day 13.

import { NextRequest, NextResponse } from 'next/server';
import {
  type TgUpdate,
  type TgMessage,
  type InlineKeyboard,
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  downloadFileAsText,
  sendDocument,
} from '@/lib/telegram';
import { buildCatalogCsv } from '@/lib/usmon-catalog-export';
import { parseUsmonCsv } from '@/lib/usmon-csv-parser';
import { parseSupplyMessage } from '@/lib/parse-supply-message';
import { query, withTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function verifySecret(req: NextRequest): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true;
  return req.headers.get('x-telegram-bot-api-secret-token') === expected;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifySecret(req)) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 });
  }

  try {
    if (update.message?.document) {
      await handleDocument(update.message);
    } else if (update.message?.text) {
      await handleText(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  return NextResponse.json({ ok: true });
}

// ─── Main menu (updated for Stage 1) ─────────────────────────────────────────

const MAIN_MENU: InlineKeyboard = [
  [
    { text: "📋 Today's list", callback_data: 'menu:today' },
    { text: '📦 Pending receipts', callback_data: 'menu:pending' },
  ],
  [
    { text: '📥 Recent reports', callback_data: 'menu:recent' },
    { text: '📊 Status', callback_data: 'menu:status' },
  ],
  [
    { text: '📞 Suppliers', callback_data: 'menu:suppliers' },
    { text: '❓ Help', callback_data: 'menu:help' },
  ],
  [
    { text: '📤 Export catalog to USmon', callback_data: 'menu:usmon_export' },
  ],
];

// ─── Pending-action state (Day 5: bot is waiting for a follow-up text) ──────

const PENDING_TTL_MINUTES = 5;

async function setPendingAction(
  telegramUserId: number,
  action: string,
  targetId: number,
): Promise<void> {
  await query(
    `UPDATE telegram_users
     SET pending_action = $1,
         pending_target_id = $2,
         pending_action_expires_at = NOW() + ($3 || ' minutes')::interval
     WHERE telegram_user_id = $4`,
    [action, targetId, String(PENDING_TTL_MINUTES), telegramUserId],
  );
}

async function clearPendingAction(telegramUserId: number): Promise<void> {
  await query(
    `UPDATE telegram_users
     SET pending_action = NULL, pending_target_id = NULL, pending_action_expires_at = NULL
     WHERE telegram_user_id = $1`,
    [telegramUserId],
  );
}

async function getPendingAction(
  telegramUserId: number,
): Promise<{ action: string; targetId: number } | null> {
  const r = await query<{ pending_action: string; pending_target_id: string; expired: boolean }>(
    `SELECT pending_action, pending_target_id::text AS pending_target_id,
            (pending_action_expires_at < NOW()) AS expired
     FROM telegram_users
     WHERE telegram_user_id = $1 AND pending_action IS NOT NULL`,
    [telegramUserId],
  );
  if (r.rows.length === 0) return null;
  if (r.rows[0].expired) {
    await clearPendingAction(telegramUserId);
    return null;
  }
  return {
    action: r.rows[0].pending_action,
    targetId: parseInt(r.rows[0].pending_target_id, 10),
  };
}

// ─── Telegram_users helpers ──────────────────────────────────────────────────

async function trackUser(msg: TgMessage): Promise<{ id: number; first_seen: boolean }> {
  const from = msg.from;
  if (!from) return { id: 0, first_seen: false };
  const existing = await query<{ id: number }>(
    `SELECT id FROM telegram_users WHERE telegram_user_id = $1`,
    [from.id],
  );
  if (existing.rows.length > 0) {
    await query(
      `UPDATE telegram_users SET last_seen_at = NOW() WHERE telegram_user_id = $1`,
      [from.id],
    );
    return { id: existing.rows[0].id, first_seen: false };
  }
  const inserted = await query<{ id: number }>(
    `INSERT INTO telegram_users (telegram_user_id, telegram_chat_id, first_name, username, role)
     VALUES ($1, $2, $3, $4, 'tech')
     RETURNING id`,
    [from.id, msg.chat.id, from.first_name ?? null, from.username ?? null],
  );
  return { id: inserted.rows[0].id, first_seen: true };
}

// ─── Text message branch ────────────────────────────────────────────────────

async function handleText(msg: TgMessage): Promise<void> {
  const text = (msg.text ?? '').trim();
  const chatId = msg.chat.id;
  const fromId = msg.from?.id ?? 0;
  const { first_seen } = await trackUser(msg);

  // Day 5: pending action takes precedence over both menu commands and parser.
  // The bot may be waiting for a lot number (or other follow-up) from this user.
  if (fromId) {
    const pending = await getPendingAction(fromId);
    if (pending) {
      // /menu always escapes any pending state
      if (text === '/menu' || text === '/start' || text.toLowerCase() === 'menu') {
        await clearPendingAction(fromId);
        await sendMainMenu(chatId, 'Cancelled. Main menu:');
        return;
      }
      if (pending.action === 'awaiting_lot_number') {
        await handleLotNumberReply(chatId, fromId, pending.targetId, text);
        return;
      }
      // Unknown pending action — clear and fall through
      await clearPendingAction(fromId);
    }
  }

  if (text === '/start' || text === '/menu' || text.toLowerCase() === 'menu') {
    await sendMainMenu(chatId, first_seen ? newUserWelcome(msg) : welcomeText(msg));
    return;
  }

  // Anything else → supply report parse
  await handleSupplyReport(msg, text);
}

async function handleSupplyReport(msg: TgMessage, text: string): Promise<void> {
  const chatId = msg.chat.id;
  const fromId = msg.from?.id ?? 0;
  const fromName = msg.from?.first_name ?? null;

  const result = await parseSupplyMessage(text);

  // PHI rejection
  if (result.phi_rejected) {
    await sendMessage({
      chatId,
      text:
        `🚫 *Held that message — PHI signal detected.*\n\n` +
        `(${result.phi_reason ?? 'PHI pattern in message'})\n\n` +
        `This system never accepts patient-linked data (per ADR-005). ` +
        `Could you rephrase without any reference to patients, cases, or surgeons? ` +
        `Operational items + locations only.`,
      parseMode: 'Markdown',
    });
    return;
  }

  if (!result.ok || !result.parsed) {
    await sendMessage({
      chatId,
      text: `⚠️ Couldn't parse that message: ${result.error ?? 'unknown error'}\n\nTap /menu to do something else.`,
    });
    return;
  }

  const p = result.parsed;

  // Not a supply report
  if (!p.is_supply_report) {
    await sendMessage({
      chatId,
      text:
        `Hmm, that didn't look like a supply report — ${p.non_supply_reason ?? 'not a stock message'}.\n\n` +
        `Tap /menu for the main menu, or text me something like *"low on dragonfly"* or *"out of needles at Lakeside"*.`,
      parseMode: 'Markdown',
    });
    return;
  }

  // Persist
  const inserted = await query<{ id: number }>(
    `INSERT INTO supply_requests
       (telegram_user_id, telegram_chat_id, telegram_message_id, reporter_first_name,
        raw_message, is_supply_report, parsed_item, parsed_location_hint, parsed_urgency,
        parsed_quantity, parse_confidence, parse_reasoning, parse_model, parse_raw_jsonb,
        parse_cost_usd)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      fromId,
      chatId,
      msg.message_id,
      fromName,
      text,
      p.item,
      p.location_hint,
      p.urgency,
      p.quantity,
      p.confidence,
      p.reasoning,
      result.model_used,
      JSON.stringify(p),
      result.cost_usd,
    ],
  );
  const reqId = inserted.rows[0].id;

  // Confirm to the reporter
  const urgencyEmoji =
    p.urgency === 'high' ? '🚨' : p.urgency === 'medium' ? '⏰' : '📝';
  const quantityLine = p.quantity ? ` · qty ~${p.quantity}` : '';
  const locationLine = p.location_hint ? ` @ ${p.location_hint}` : '';

  // Day 6: surface recurring-order suggestion if this item has been ordered before
  let recurringHint = '';
  let recurringButton: { text: string; callback_data: string } | null = null;
  if (p.item) {
    const past = await query<{
      quantity_ordered: number | null;
      ordered_at_text: string;
      days_ago: string;
      supplier_name_snapshot: string | null;
    }>(
      `SELECT quantity_ordered,
              TO_CHAR(ordered_at, 'Mon DD, YYYY') AS ordered_at_text,
              EXTRACT(DAY FROM (NOW() - ordered_at))::text AS days_ago,
              supplier_name_snapshot
       FROM reorders
       WHERE LOWER(item_name_snapshot) LIKE LOWER($1)
       ORDER BY ordered_at DESC
       LIMIT 1`,
      [`%${p.item}%`],
    );
    if (past.rows.length > 0) {
      const r = past.rows[0];
      const qtyText = r.quantity_ordered ? `${r.quantity_ordered}` : 'some';
      const days = parseInt(r.days_ago, 10);
      const supplier = r.supplier_name_snapshot ? ` from ${r.supplier_name_snapshot}` : '';
      recurringHint =
        `\n\n💡 _You last ordered ${qtyText} of these${supplier} on ${r.ordered_at_text} (${days}d ago)._`;
      if (r.quantity_ordered) {
        recurringButton = {
          text: `🔁 Order ${r.quantity_ordered} like last time`,
          callback_data: `ord:${reqId}:${r.quantity_ordered}`,
        };
      }
    }
  }

  const baseKeyboard: InlineKeyboard = [
    [
      { text: '✅ Mark ordered', callback_data: `ord:${reqId}` },
      { text: '📧 Draft email', callback_data: `mail:${reqId}` },
    ],
    [
      { text: "📋 Today's list", callback_data: 'menu:today' },
      { text: '🏠 Main menu', callback_data: 'menu:main' },
    ],
  ];
  if (recurringButton) {
    // Insert the recurring button as the first row above the standard actions
    baseKeyboard.unshift([recurringButton]);
  }

  await sendMessage({
    chatId,
    text:
      `${urgencyEmoji} Logged: *${p.item ?? 'unknown item'}*${locationLine}${quantityLine}\n` +
      `_(${p.urgency} priority, confidence ${Math.round(p.confidence * 100)}%)_\n\n` +
      `Request #${reqId}. ${p.reasoning}` +
      recurringHint,
    parseMode: 'Markdown',
    replyMarkup: { inline_keyboard: baseKeyboard },
  });
}

// ─── Callback (button) handler ───────────────────────────────────────────────

async function handleCallback(cb: {
  id: string;
  from: { id: number; first_name?: string };
  message?: TgMessage;
  data?: string;
}): Promise<void> {
  await answerCallbackQuery(cb.id);
  const chatId = cb.message?.chat.id ?? cb.from.id;
  const action = cb.data ?? '';

  // Day 4: action buttons attached to digest items
  // ord:<request_id> or ord:<request_id>:<qty>
  if (action.startsWith('ord:')) {
    const parts = action.split(':');
    const requestId = parseInt(parts[1] ?? '', 10);
    const explicitQty = parts[2] ? parseInt(parts[2], 10) : null;
    if (!Number.isNaN(requestId)) {
      await handleMarkOrdered(chatId, requestId, cb.from.id, explicitQty);
    }
    return;
  }
  if (action.startsWith('mail:')) {
    const requestId = parseInt(action.slice(5), 10);
    if (!Number.isNaN(requestId)) {
      await handleDraftEmail(chatId, requestId);
    }
    return;
  }
  // Day 4.5: live-edit quantity on the draft email — re-render the same message
  // mailq:<request_id>:<new_qty>
  if (action.startsWith('mailq:')) {
    const parts = action.split(':');
    const requestId = parseInt(parts[1] ?? '', 10);
    const newQty = parseInt(parts[2] ?? '', 10);
    const messageId = cb.message?.message_id;
    if (!Number.isNaN(requestId) && !Number.isNaN(newQty) && newQty >= 1 && messageId) {
      await handleEditDraftQty(chatId, messageId, requestId, newQty);
    }
    return;
  }
  // Noop — used by the live "qty: N" display button so taps don't error out
  if (action === 'noop') return;
  // Day 5: Mark received → ask for lot number
  if (action.startsWith('rcv:')) {
    const reorderId = parseInt(action.slice(4), 10);
    if (!Number.isNaN(reorderId)) {
      await handleMarkReceivedStart(chatId, cb.from.id, reorderId);
    }
    return;
  }
  if (action === 'menu:main') {
    await sendMainMenu(chatId, 'Main menu:');
    return;
  }

  switch (action) {
    case 'menu:today':
      await sendTodaysList(chatId);
      break;
    case 'menu:pending':
      await sendPendingReceipts(chatId);
      break;
    case 'menu:recent':
      await sendRecent(chatId);
      break;
    case 'menu:status':
      await sendStatus(chatId);
      break;
    case 'menu:suppliers':
      await sendSuppliers(chatId);
      break;
    case 'menu:upload':
      await sendUploadInstructions(chatId);
      break;
    case 'menu:usmon_export':
      await sendUsmonCatalogExport(chatId);
      break;
    case 'menu:help':
      await sendHelp(chatId);
      break;
    default:
      await sendMainMenu(chatId, "I didn't recognize that. Here's the menu:");
  }
}

// ─── Day 6: Pending receipts view ────────────────────────────────────────────

async function sendPendingReceipts(chatId: number): Promise<void> {
  const r = await query<{
    id: string;
    item_name_snapshot: string;
    quantity_ordered: string | null;
    supplier_name_snapshot: string | null;
    ordered_at: string;
    days_open: string;
  }>(`
    SELECT id::text, item_name_snapshot, quantity_ordered::text,
           supplier_name_snapshot,
           TO_CHAR(ordered_at, 'Mon DD') AS ordered_at,
           EXTRACT(DAY FROM (NOW() - ordered_at))::text AS days_open
    FROM reorders
    WHERE received_at IS NULL
    ORDER BY ordered_at ASC
  `);

  if (r.rows.length === 0) {
    await sendMessage({
      chatId,
      text:
        `📦 *Pending receipts*\n\n` +
        `All caught up — nothing waiting to arrive.\n\n` +
        `Tap /menu for more.`,
      parseMode: 'Markdown',
    });
    return;
  }

  await sendMessage({
    chatId,
    text: `📦 *Pending receipts* — ${r.rows.length} order${r.rows.length === 1 ? '' : 's'} not yet marked received:`,
    parseMode: 'Markdown',
  });

  for (const row of r.rows) {
    const days = parseInt(row.days_open, 10);
    const daysFlag = days >= 3 ? ` _⚠️ ${days}d ago — follow up?_` : ` _(${days}d ago)_`;
    const qty = row.quantity_ordered ? ` · qty ${row.quantity_ordered}` : '';
    const supplier = row.supplier_name_snapshot ?? 'unknown supplier';

    await sendMessage({
      chatId,
      text:
        `• *${row.item_name_snapshot}*${qty}\n` +
        `   from ${supplier} · ordered ${row.ordered_at}${daysFlag}`,
      parseMode: 'Markdown',
      replyMarkup: {
        inline_keyboard: [
          [
            { text: '📦 Mark received', callback_data: `rcv:${row.id}` },
            { text: '🏠 Main menu', callback_data: 'menu:main' },
          ],
        ],
      },
    });
  }
}

// ─── Document (CSV) handler — kept as legacy backup ─────────────────────────

async function handleDocument(msg: TgMessage): Promise<void> {
  const doc = msg.document!;
  const chatId = msg.chat.id;
  await trackUser(msg);

  const filename = doc.file_name ?? 'unknown.csv';
  const isCsv =
    filename.toLowerCase().endsWith('.csv') ||
    doc.mime_type === 'text/csv' ||
    doc.mime_type === 'application/vnd.ms-excel';

  if (!isCsv) {
    await sendMessage({
      chatId,
      text:
        `I can only ingest CSV files via upload. Got: \`${filename}\` (${doc.mime_type ?? 'unknown'}).\n\n` +
        `For low-stock reports, just text me normally — no file needed.`,
      parseMode: 'Markdown',
    });
    return;
  }

  await sendMessage({ chatId, text: `📥 Got \`${filename}\`. Processing...`, parseMode: 'Markdown' });

  let csvText: string;
  try {
    const { text } = await downloadFileAsText(doc.file_id);
    csvText = text;
  } catch (err) {
    await sendMessage({
      chatId,
      text: `❌ Could not download from Telegram: ${err instanceof Error ? err.message : 'unknown'}`,
    });
    return;
  }

  const parsed = parseUsmonCsv(csvText, filename);

  if (!parsed.phi_check.passed) {
    await sendMessage({
      chatId,
      text:
        `🚫 *Rejected — PHI columns detected.*\n\n` +
        `Rejected: ${parsed.phi_check.rejected_columns.map((c) => `\`${c}\``).join(', ')}\n\n` +
        `Re-export from USmon without these columns.`,
      parseMode: 'Markdown',
    });
    return;
  }

  if (!parsed.ok || parsed.items.length === 0) {
    await sendMessage({
      chatId,
      text:
        parsed.items.length === 0
          ? `✅ File accepted but contained 0 data rows.`
          : `⚠️ Parse errors:\n${parsed.errors.map((e) => `• ${e}`).join('\n')}`,
    });
    return;
  }

  await withTransaction(async (client) => {
    const importInsert = await client.query<{ id: number }>(
      `INSERT INTO csv_imports (source_filename, row_count, ingested_at)
       VALUES ($1, $2, NOW()) RETURNING id`,
      [filename, parsed.items.length],
    );
    const importId = importInsert.rows[0].id;
    for (const item of parsed.items) {
      const loc = await client.query<{ id: number }>(
        `INSERT INTO locations (usmon_location_id, name)
         VALUES ($1, $2)
         ON CONFLICT (usmon_location_id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [item.location_id || `unknown-${item.location_name}`, item.location_name],
      );
      const itemRow = await client.query<{ id: number }>(
        `INSERT INTO items (name, manufacturer, manufacturer_number)
         VALUES ($1, $2, $3)
         ON CONFLICT (name, manufacturer) DO UPDATE
           SET manufacturer_number = EXCLUDED.manufacturer_number
         RETURNING id`,
        [item.item_name, item.manufacturer, item.manufacturer_number],
      );
      await client.query(
        `INSERT INTO daily_counts (item_id, location_id, quantity, recorded_at, csv_import_id)
         VALUES ($1, $2, $3, NOW(), $4)`,
        [itemRow.rows[0].id, loc.rows[0].id, item.quantity_on_hand, importId],
      );
    }
  });

  await sendMessage({
    chatId,
    text:
      `✅ *Ingested ${parsed.items.length} row${parsed.items.length === 1 ? '' : 's'}*\n` +
      `File: \`${filename}\`\n\nTap /menu for next actions.`,
    parseMode: 'Markdown',
  });
}

// ─── Menu rendering ─────────────────────────────────────────────────────────

async function sendMainMenu(chatId: number, intro: string): Promise<void> {
  await sendMessage({
    chatId,
    text: intro,
    replyMarkup: { inline_keyboard: MAIN_MENU },
  });
}

function welcomeText(msg: TgMessage): string {
  const name = msg.from?.first_name ?? 'there';
  return (
    `👋 Hi ${name} — this is USmon-Auto staging.\n\n` +
    `Just text me when something's running low — no special commands. ` +
    `Examples:\n` +
    `• "low on dragonfly"\n` +
    `• "need more pads at Lakeside"\n` +
    `• "out of single needles, send 20 asap"\n\n` +
    `I never touch patient data (per ADR-005 — 6 layers of enforcement).\n\n` +
    `Tap a button below for the buyer view:`
  );
}

function newUserWelcome(msg: TgMessage): string {
  const name = msg.from?.first_name ?? 'there';
  return (
    `👋 Hey ${name} — first time? Welcome.\n\n` +
    `*If you're a tech:* when supplies are running low, just text me like you'd text the buyer. Examples:\n` +
    `• "low on dragonfly"\n` +
    `• "need more pads at Lakeside"\n` +
    `• "out of single needles, send 20"\n\n` +
    `Casual is fine — I read your message with Claude (AI) and pass it on to the buyer in a clean morning list.\n\n` +
    `*If you're the buyer:* the buttons below show today's list and recent reports.`
  );
}

// ─── Button actions ─────────────────────────────────────────────────────────

async function sendTodaysList(chatId: number): Promise<void> {
  const r = await query<{
    parsed_item: string;
    sample_request_id: string;
    count: string;
    locations: string;
    reporters: string;
    highest_urgency: string;
    highest_quantity: string | null;
  }>(`
    SELECT
      COALESCE(parsed_item, 'unknown item') AS parsed_item,
      MAX(id)::text AS sample_request_id,
      COUNT(*)::text AS count,
      STRING_AGG(DISTINCT COALESCE(parsed_location_hint, ''), ', ') FILTER (WHERE parsed_location_hint IS NOT NULL AND parsed_location_hint <> '') AS locations,
      STRING_AGG(DISTINCT COALESCE(reporter_first_name, 'anon'), ', ') AS reporters,
      CASE MAX(
        CASE parsed_urgency
          WHEN 'high' THEN 3
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 1
          ELSE 0
        END
      )
        WHEN 3 THEN 'high'
        WHEN 2 THEN 'medium'
        WHEN 1 THEN 'low'
        ELSE 'unknown'
      END AS highest_urgency,
      MAX(parsed_quantity)::text AS highest_quantity
    FROM supply_requests
    WHERE is_supply_report = TRUE
      AND superseded_by_reorder_id IS NULL
      AND reported_at > NOW() - INTERVAL '24 hours'
    GROUP BY COALESCE(parsed_item, 'unknown item')
    ORDER BY
      MAX(
        CASE parsed_urgency
          WHEN 'high' THEN 3
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 1
          ELSE 0
        END
      ) DESC,
      COUNT(*) DESC
  `);

  if (r.rows.length === 0) {
    await sendMessage({
      chatId,
      text: `📋 *Today's list*\n\nNothing reported in the last 24 hours. All quiet.\n\nTap /menu for more.`,
      parseMode: 'Markdown',
    });
    return;
  }

  // Intro line
  await sendMessage({
    chatId,
    text: `📋 *Today's list* — ${r.rows.length} item${r.rows.length === 1 ? '' : 's'} need${r.rows.length === 1 ? 's' : ''} attention:`,
    parseMode: 'Markdown',
  });

  // One message per item with action buttons
  for (const row of r.rows) {
    const urgencyMark =
      row.highest_urgency === 'high' ? '🚨' : row.highest_urgency === 'medium' ? '⏰' : '•';
    const locs = row.locations ? ` _@ ${row.locations}_` : '';
    const count = parseInt(row.count, 10);
    const countText = count > 1 ? ` _(${count} reports)_` : '';
    const qty = row.highest_quantity ? ` · suggested qty ~${row.highest_quantity}` : '';

    const lines = [
      `${urgencyMark} *${row.parsed_item}*${locs}${countText}`,
      `   reported by ${row.reporters}${qty}`,
    ];

    await sendMessage({
      chatId,
      text: lines.join('\n'),
      parseMode: 'Markdown',
      replyMarkup: {
        inline_keyboard: [
          [
            { text: '✅ Mark ordered', callback_data: `ord:${row.sample_request_id}` },
            { text: '📧 Draft email', callback_data: `mail:${row.sample_request_id}` },
          ],
        ],
      },
    });
  }
}

// ─── Day 4: handle "Mark ordered" action ────────────────────────────────────

async function handleMarkOrdered(
  chatId: number,
  sampleRequestId: number,
  taggerTelegramId: number,
  explicitQty: number | null = null,
): Promise<void> {
  const lookup = await query<{
    parsed_item: string;
    item_id: number | null;
    highest_quantity: number | null;
  }>(
    `SELECT parsed_item, item_id, parsed_quantity AS highest_quantity
     FROM supply_requests WHERE id = $1`,
    [sampleRequestId],
  );
  if (lookup.rows.length === 0) {
    await sendMessage({ chatId, text: `⚠️ Couldn't find that request anymore (it may have been ordered already).` });
    return;
  }
  const { parsed_item, item_id, highest_quantity: parsedQty } = lookup.rows[0];
  // Prefer the user's edited quantity from the email draft; fall back to parsed
  const highest_quantity = explicitQty ?? parsedQty;

  // Default supplier = Primary Supplier (the only one we have for now)
  const supplier = await query<{ id: number; name: string }>(
    `SELECT id, name FROM suppliers WHERE active = TRUE ORDER BY id LIMIT 1`,
  );
  const supplierId = supplier.rows[0]?.id ?? null;
  const supplierName = supplier.rows[0]?.name ?? null;

  // Find all matching unhandled supply_requests in the last 24h with the same parsed_item.
  // Tightening the scope to "last 24h" matches what Today's list shows.
  const matchingRequests = await query<{ id: number }>(
    `SELECT id FROM supply_requests
     WHERE parsed_item = $1
       AND is_supply_report = TRUE
       AND superseded_by_reorder_id IS NULL
       AND reported_at > NOW() - INTERVAL '24 hours'`,
    [parsed_item],
  );

  let reorderId: number | null = null;
  await withTransaction(async (client) => {
    const reorder = await client.query<{ id: number }>(
      `INSERT INTO reorders
        (item_id, item_name_snapshot, supplier_id, supplier_name_snapshot,
         quantity_ordered, ordered_at, ordered_by_telegram_user_id,
         follow_up_at, source_request_count)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, NOW() + INTERVAL '24 hours', $7)
       RETURNING id`,
      [
        item_id,
        parsed_item ?? 'unknown',
        supplierId,
        supplierName,
        highest_quantity,
        taggerTelegramId,
        matchingRequests.rows.length,
      ],
    );
    reorderId = reorder.rows[0].id;

    if (matchingRequests.rows.length > 0) {
      const ids = matchingRequests.rows.map((r) => r.id);
      await client.query(
        `UPDATE supply_requests SET superseded_by_reorder_id = $1 WHERE id = ANY($2::bigint[])`,
        [reorderId, ids],
      );
    }
  });

  const supplierLine = supplierName ? `from *${supplierName}*` : 'from your supplier';
  const qtyLine = highest_quantity ? ` (qty ~${highest_quantity})` : '';
  await sendMessage({
    chatId,
    text:
      `✅ Marked *${parsed_item}*${qtyLine} as ordered ${supplierLine}.\n\n` +
      `${matchingRequests.rows.length} report${matchingRequests.rows.length === 1 ? '' : 's'} cleared. ` +
      `Reorder #${reorderId}. When the box arrives, tap *Mark received* and I'll log the lot number for JCAHO traceability.`,
    parseMode: 'Markdown',
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '📦 Mark received', callback_data: `rcv:${reorderId}` },
          { text: '🏠 Main menu', callback_data: 'menu:main' },
        ],
      ],
    },
  });
}

// ─── Day 5: Mark received + lot number capture ───────────────────────────────

async function handleMarkReceivedStart(
  chatId: number,
  telegramUserId: number,
  reorderId: number,
): Promise<void> {
  const lookup = await query<{
    item_name_snapshot: string;
    received_at: string | null;
  }>(
    `SELECT item_name_snapshot, received_at::text AS received_at
     FROM reorders WHERE id = $1`,
    [reorderId],
  );
  if (lookup.rows.length === 0) {
    await sendMessage({ chatId, text: `⚠️ Couldn't find that order anymore.` });
    return;
  }
  if (lookup.rows[0].received_at) {
    await sendMessage({
      chatId,
      text: `📦 That order is already marked received (${lookup.rows[0].received_at}). Nothing to do.\n\nTap /menu for more.`,
    });
    return;
  }

  await setPendingAction(telegramUserId, 'awaiting_lot_number', reorderId);

  await sendMessage({
    chatId,
    text:
      `📦 *Mark received: ${lookup.rows[0].item_name_snapshot}*\n\n` +
      `Reply with the *lot number* from the box (e.g. \`104907\`).\n\n` +
      `Or reply *skip* to mark received without a lot. ` +
      `Or tap /menu to cancel.\n\n` +
      `_(JCAHO requires lot traceability for sterile devices — this is the compliance value-add layer.)_`,
    parseMode: 'Markdown',
  });
}

async function handleLotNumberReply(
  chatId: number,
  telegramUserId: number,
  reorderId: number,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  const isSkip = /^skip$/i.test(trimmed);

  if (isSkip) {
    await query(
      `UPDATE reorders
       SET received_at = NOW(), received_by_telegram_user_id = $1, lot_number = NULL
       WHERE id = $2`,
      [telegramUserId, reorderId],
    );
    await clearPendingAction(telegramUserId);
    await sendMessage({
      chatId,
      text: `📦 Marked received without a lot number. (Heads-up: JCAHO audits may flag this — fine for now, just noting.)\n\nTap /menu for more.`,
    });
    return;
  }

  // Validate lot # format — most are 6-9 digits, but some can be alphanumeric.
  // Be permissive: 4-20 chars, alphanumeric + dash.
  if (!/^[A-Za-z0-9-]{3,20}$/.test(trimmed)) {
    await sendMessage({
      chatId,
      text:
        `That doesn't look like a lot number — usually 4-20 letters/digits (e.g. \`104907\`).\n\n` +
        `Try again, or reply *skip* or tap /menu to cancel.`,
      parseMode: 'Markdown',
    });
    return;
  }

  // Light PHI check on the lot value — shouldn't contain anything PHI-shaped
  // but the layered defense applies (per ADR-005).
  if (/patient|mrn|case|surgeon|dob/i.test(trimmed)) {
    await sendMessage({
      chatId,
      text: `🚫 That value contains a word I flag as PHI-adjacent. Lot numbers are normally just digits or short codes. Reply *skip* or /menu to cancel.`,
    });
    return;
  }

  await query(
    `UPDATE reorders
     SET received_at = NOW(), received_by_telegram_user_id = $1, lot_number = $2
     WHERE id = $3`,
    [telegramUserId, trimmed, reorderId],
  );
  await clearPendingAction(telegramUserId);

  await sendMessage({
    chatId,
    text:
      `📦 *Received.* Lot \`${trimmed}\` logged. JCAHO traceability ✓\n\n` +
      `If this lot is ever recalled, I'll surface it under /menu → Recalls (Day 13 feature).\n\n` +
      `Tap /menu for more.`,
    parseMode: 'Markdown',
  });
}

// ─── Day 4.5: editable email draft with +/- quantity controls ────────────────

/**
 * Render the editable email-draft message body + keyboard given a current quantity.
 * Used both for the initial send AND for live re-render after each +/- tap.
 */
async function renderEmailDraft(
  sampleRequestId: number,
  qty: number,
): Promise<{ text: string; keyboard: InlineKeyboard } | null> {
  const lookup = await query<{
    parsed_item: string;
    parsed_location_hint: string | null;
    item_manufacturer_number: string | null;
  }>(
    `SELECT sr.parsed_item, sr.parsed_location_hint,
            i.manufacturer_number AS item_manufacturer_number
     FROM supply_requests sr
     LEFT JOIN items i ON i.id = sr.item_id
     WHERE sr.id = $1`,
    [sampleRequestId],
  );
  if (lookup.rows.length === 0) return null;

  const { parsed_item, parsed_location_hint, item_manufacturer_number } = lookup.rows[0];

  let sku = item_manufacturer_number;
  if (!sku) {
    const guess = await query<{ manufacturer_number: string }>(
      `SELECT manufacturer_number FROM items
       WHERE LOWER(name) LIKE LOWER($1) AND manufacturer_number IS NOT NULL
       LIMIT 1`,
      [`%${parsed_item ?? ''}%`],
    );
    sku = guess.rows[0]?.manufacturer_number ?? null;
  }

  const skuLine = sku ? ` (SKU: ${sku})` : '';
  const qtyLine = `${qty} unit${qty === 1 ? '' : 's'} of `;
  const locLine = parsed_location_hint ? `\nShip to: ${parsed_location_hint}` : '';

  const subject = `Order request — Operator / Operator`;
  const body =
    `Hi,\n\n` +
    `Please ship ${qtyLine}${parsed_item ?? 'the supply item below'}${skuLine}.${locLine}\n\n` +
    `Bill to: Operator — Operator — [bill-to address on file]\n` +
    `Payment: VISA on file\n\n` +
    `Thanks,\nthe buyer`;

  const text =
    `📧 Email draft for *${parsed_item}*\n\n` +
    `Adjust the quantity below if needed, then long-press the body to copy.\n\n` +
    `*To:* sales@[supplier-website]\n` +
    `*Subject:* ${subject}\n\n` +
    `\`\`\`\n${body}\n\`\`\``;

  const keyboard: InlineKeyboard = [
    [
      { text: '➖ 5', callback_data: `mailq:${sampleRequestId}:${Math.max(1, qty - 5)}` },
      { text: '➖ 1', callback_data: `mailq:${sampleRequestId}:${Math.max(1, qty - 1)}` },
      { text: `qty: ${qty}`, callback_data: 'noop' },
      { text: '➕ 1', callback_data: `mailq:${sampleRequestId}:${qty + 1}` },
      { text: '➕ 5', callback_data: `mailq:${sampleRequestId}:${qty + 5}` },
    ],
    [
      { text: '✅ Sent it — mark ordered', callback_data: `ord:${sampleRequestId}:${qty}` },
      { text: '🏠 Main menu', callback_data: 'menu:main' },
    ],
  ];

  return { text, keyboard };
}

async function handleDraftEmail(chatId: number, sampleRequestId: number): Promise<void> {
  // Initial quantity = parsed value if present, else 1
  const reqLookup = await query<{ parsed_quantity: number | null }>(
    `SELECT parsed_quantity FROM supply_requests WHERE id = $1`,
    [sampleRequestId],
  );
  if (reqLookup.rows.length === 0) {
    await sendMessage({ chatId, text: `⚠️ Couldn't find that request anymore.` });
    return;
  }
  const initialQty = reqLookup.rows[0].parsed_quantity ?? 1;

  const draft = await renderEmailDraft(sampleRequestId, initialQty);
  if (!draft) {
    await sendMessage({ chatId, text: `⚠️ Couldn't build that draft.` });
    return;
  }

  await sendMessage({
    chatId,
    text: draft.text,
    parseMode: 'Markdown',
    replyMarkup: { inline_keyboard: draft.keyboard },
  });
}

async function handleEditDraftQty(
  chatId: number,
  messageId: number,
  sampleRequestId: number,
  newQty: number,
): Promise<void> {
  const draft = await renderEmailDraft(sampleRequestId, newQty);
  if (!draft) return;
  await editMessageText({
    chatId,
    messageId,
    text: draft.text,
    parseMode: 'Markdown',
    replyMarkup: { inline_keyboard: draft.keyboard },
  });
}

async function sendRecent(chatId: number): Promise<void> {
  const r = await query<{
    id: string;
    raw_message: string;
    reporter_first_name: string | null;
    parsed_item: string | null;
    parsed_urgency: string | null;
    reported_at: string;
  }>(`
    SELECT id::text, raw_message, reporter_first_name, parsed_item, parsed_urgency,
           TO_CHAR(reported_at, 'HH24:MI Mon DD') AS reported_at
    FROM supply_requests
    WHERE is_supply_report = TRUE
    ORDER BY reported_at DESC
    LIMIT 5
  `);

  if (r.rows.length === 0) {
    await sendMessage({
      chatId,
      text: `📥 *Recent reports*\n\nNo reports yet. Text me when something's low and I'll log it.\n\nTap /menu.`,
      parseMode: 'Markdown',
    });
    return;
  }

  const lines = r.rows.map((row) => {
    const urgencyMark =
      row.parsed_urgency === 'high' ? '🚨' : row.parsed_urgency === 'medium' ? '⏰' : '📝';
    return (
      `${urgencyMark} #${row.id} · *${row.parsed_item ?? 'unknown'}* · _${row.reporter_first_name ?? 'anon'}_ · ${row.reported_at}\n` +
      `   "${row.raw_message.slice(0, 80)}${row.raw_message.length > 80 ? '...' : ''}"`
    );
  });

  await sendMessage({
    chatId,
    text: `📥 *Recent reports* (last 5)\n\n` + lines.join('\n\n') + `\n\nTap /menu.`,
    parseMode: 'Markdown',
  });
}

async function sendStatus(chatId: number): Promise<void> {
  const r = await query<{
    requests_24h: string;
    requests_total: string;
    distinct_items: string;
    techs: string;
  }>(`
    SELECT
      (SELECT COUNT(*)::text FROM supply_requests WHERE reported_at > NOW() - INTERVAL '24 hours') AS requests_24h,
      (SELECT COUNT(*)::text FROM supply_requests) AS requests_total,
      (SELECT COUNT(DISTINCT parsed_item)::text FROM supply_requests WHERE parsed_item IS NOT NULL) AS distinct_items,
      (SELECT COUNT(*)::text FROM telegram_users WHERE active = TRUE) AS techs
  `);
  const row = r.rows[0];
  await sendMessage({
    chatId,
    text:
      `📊 *Status*\n\n` +
      `Reports (24h): *${row.requests_24h}*\n` +
      `Reports (all-time): *${row.requests_total}*\n` +
      `Distinct items: *${row.distinct_items}*\n` +
      `Active users: *${row.techs}*\n\n` +
      `Tap /menu.`,
    parseMode: 'Markdown',
  });
}

async function sendSuppliers(chatId: number): Promise<void> {
  const r = await query<{
    name: string;
    contact_name: string | null;
    phone: string | null;
    typical_lead_hours: string | null;
  }>(`SELECT name, contact_name, phone, typical_lead_hours::text FROM suppliers WHERE active = TRUE`);

  if (r.rows.length === 0) {
    await sendMessage({
      chatId,
      text:
        `📞 *Suppliers*\n\n` +
        `No suppliers configured yet. Once the buyer shares supplier info, I'll list them here so you know who to call.`,
      parseMode: 'Markdown',
    });
    return;
  }

  const lines = r.rows.map((s) => {
    const lead = s.typical_lead_hours ? ` (${s.typical_lead_hours}h lead)` : '';
    return `• *${s.name}* — ${s.contact_name ?? 'no contact'} · ${s.phone ?? 'no phone'}${lead}`;
  });

  await sendMessage({
    chatId,
    text: `📞 *Suppliers*\n\n` + lines.join('\n'),
    parseMode: 'Markdown',
  });
}

async function sendUploadInstructions(chatId: number): Promise<void> {
  await sendMessage({
    chatId,
    text:
      `📤 *CSV upload (backup path)*\n\n` +
      `Per ADR-008, the main flow now is to text me low-stock reports directly. ` +
      `But the original USmon CSV import still works if you ever want to bulk-load.\n\n` +
      `*Steps:*\n` +
      `1. USmon → Others → Inventory → Inventory Reports\n` +
      `2. Stock Per Supply → MS Excel (CSV) → Generate\n` +
      `3. Send the file to me here as an attachment\n\n` +
      `⚠️ Never select report types named "Patient" or "Surgeon" — those are PHI and I'll reject them.`,
    parseMode: 'Markdown',
  });
}

// ─── Day 7 (Stage 2 bridge): export accumulated catalog to USmon ──────────────

async function sendUsmonCatalogExport(chatId: number): Promise<void> {
  const { rows, csv } = await buildCatalogCsv();

  if (rows === 0) {
    await sendMessage({
      chatId,
      text:
        `📤 *Export catalog to USmon*\n\n` +
        `Nothing to export yet — I need a bit of history first. Once your techs have reported a few items and you've marked some as ordered, I'll have enough to build a real USmon catalog.\n\n` +
        `Come back in a week or two.`,
      parseMode: 'Markdown',
    });
    return;
  }

  const filename = `usmon-catalog-${new Date().toISOString().slice(0, 10)}.csv`;

  await sendDocument({
    chatId,
    filename,
    contentType: 'text/csv; charset=utf-8',
    body: csv,
    caption:
      `📤 *USmon catalog* — ${rows} item${rows === 1 ? '' : 's'} ready to import.\n\n` +
      `*How to use it:*\n` +
      `1. Save this file to your computer.\n` +
      `2. Log into USmon → *Manager → Setup Supplies*.\n` +
      `3. Click *Import Supply Items from Master Suppliers List* (top right).\n` +
      `4. Upload this file.\n\n` +
      `USmon now has your real catalog populated from the bot's accumulated data. ` +
      `From here, USmon becomes the source of truth and the bot stays as the daily alerter on top.\n\n` +
      `_(Stage 2 of 3-stage plan per ADR-008. ADR-009 documents this bridge in detail.)_`,
    parseMode: 'Markdown',
    replyMarkup: {
      inline_keyboard: [
        [{ text: '🏠 Main menu', callback_data: 'menu:main' }],
      ],
    },
  });
}

async function sendHelp(chatId: number): Promise<void> {
  await sendMessage({
    chatId,
    text:
      `❓ *Help*\n\n` +
      `*If you're a tech:* text me when supplies are low. Just like texting the buyer.\n` +
      `• "low on dragonfly"\n` +
      `• "out of needles at Lakeside"\n` +
      `• "need 20 sticky pads asap"\n\n` +
      `*If you're the buyer:* tap buttons.\n` +
      `• 📋 Today's list — items reported in last 24h, grouped + de-duped\n` +
      `• 📥 Recent reports — last 5 individual reports with timestamps\n` +
      `• 📊 Status — counts overview\n` +
      `• 📞 Suppliers — who to call (when populated)\n` +
      `• 📤 Upload CSV — legacy USmon bulk-import path\n\n` +
      `*Privacy:* This system NEVER stores patient names, case IDs, surgeons, dates of service, or anything PHI. Messages are screened both before AND after parsing (ADR-005, 6 layers).\n\n` +
      `*Repo:* github.com/LilBuddyCode/USmon-Auto`,
    parseMode: 'Markdown',
  });
}
