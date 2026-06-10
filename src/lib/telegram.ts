// src/lib/telegram.ts
// Lightweight wrapper around Telegram Bot HTTP API.
// We don't use node-telegram-bot-api because it's polling-oriented and adds
// weight in serverless functions. Raw fetch() is cleaner.
//
// Bot token comes from TELEGRAM_BOT_TOKEN_STAGING in v1 staging env.
// Production bot uses TELEGRAM_BOT_TOKEN_PRODUCTION (Week 2).

const STAGING_TOKEN = process.env.TELEGRAM_BOT_TOKEN_STAGING;
const PRODUCTION_TOKEN = process.env.TELEGRAM_BOT_TOKEN_PRODUCTION;

function botToken(): string {
  const env = process.env.APP_ENV ?? 'staging';
  const token = env === 'production' ? PRODUCTION_TOKEN : STAGING_TOKEN;
  if (!token) {
    throw new Error(
      `No TELEGRAM_BOT_TOKEN configured for APP_ENV=${env}. ` +
        `Set TELEGRAM_BOT_TOKEN_${env.toUpperCase()} in Vercel env vars.`,
    );
  }
  return token;
}

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${botToken()}/${method}`;
}

// ─── Telegram Update types (subset we care about) ────────────────────────────

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
}

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  document?: TgDocument;
  caption?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// ─── Outgoing keyboard helpers ───────────────────────────────────────────────

export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

export type InlineKeyboard = InlineButton[][];

/** Main menu keyboard per ADR-006 (button-driven UI). */
export const MAIN_MENU_KEYBOARD: InlineKeyboard = [
  [
    { text: '📊 Status', callback_data: 'menu:status' },
    { text: '🚨 Critical', callback_data: 'menu:critical' },
  ],
  [
    { text: '⏰ Expiring', callback_data: 'menu:expiring' },
    { text: '📤 Upload CSV', callback_data: 'menu:upload' },
  ],
  [
    { text: '📈 Dashboard', url: 'https://usmon-auto-staging.vercel.app/' },
    { text: '❓ Help', callback_data: 'menu:help' },
  ],
];

// ─── API call wrappers ───────────────────────────────────────────────────────

interface SendMessageOpts {
  chatId: number | string;
  text: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  replyMarkup?: { inline_keyboard: InlineKeyboard };
  replyToMessageId?: number;
}

export async function sendMessage(opts: SendMessageOpts): Promise<TgMessage> {
  const res = await fetch(apiUrl('sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: opts.chatId,
      text: opts.text,
      parse_mode: opts.parseMode,
      reply_markup: opts.replyMarkup,
      reply_to_message_id: opts.replyToMessageId,
    }),
  });
  const json = (await res.json()) as { ok: boolean; result?: TgMessage; description?: string };
  if (!json.ok) {
    throw new Error(`Telegram sendMessage failed: ${json.description ?? 'unknown'}`);
  }
  return json.result!;
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await fetch(apiUrl('answerCallbackQuery'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
  });
}

interface EditMessageOpts {
  chatId: number | string;
  messageId: number;
  text: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  replyMarkup?: { inline_keyboard: InlineKeyboard };
}

/**
 * Replace the text + buttons of an existing bot message in-place.
 * Used for live-editable drafts (e.g., adjusting order quantity).
 */
export async function editMessageText(opts: EditMessageOpts): Promise<void> {
  const res = await fetch(apiUrl('editMessageText'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: opts.chatId,
      message_id: opts.messageId,
      text: opts.text,
      parse_mode: opts.parseMode,
      reply_markup: opts.replyMarkup,
    }),
  });
  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) {
    // Telegram returns "message is not modified" if nothing changed — non-fatal
    if (json.description?.includes('message is not modified')) return;
    throw new Error(`Telegram editMessageText failed: ${json.description ?? 'unknown'}`);
  }
}

interface FileInfo {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

/** Resolve a Telegram file_id to a downloadable URL. */
export async function getFile(fileId: string): Promise<{ url: string; info: FileInfo }> {
  const res = await fetch(apiUrl('getFile') + `?file_id=${encodeURIComponent(fileId)}`);
  const json = (await res.json()) as { ok: boolean; result?: FileInfo; description?: string };
  if (!json.ok || !json.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${json.description ?? 'no file_path returned'}`);
  }
  return {
    info: json.result,
    url: `https://api.telegram.org/file/bot${botToken()}/${json.result.file_path}`,
  };
}

/** Fetch a file from Telegram into memory as text (CSV use case). */
export async function downloadFileAsText(fileId: string): Promise<{ text: string; info: FileInfo }> {
  const { url, info } = await getFile(fileId);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Telegram file download failed: ${r.status}`);
  const text = await r.text();
  return { text, info };
}

interface SendDocumentOpts {
  chatId: number | string;
  filename: string;
  contentType: string;
  body: string;             // textual file content (CSV in our case)
  caption?: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  replyMarkup?: { inline_keyboard: InlineKeyboard };
}

/**
 * Send a text-format file (CSV/TXT/MD) to a chat as an attachment.
 * Telegram's sendDocument multipart endpoint. The user gets a downloadable file.
 */
export async function sendDocument(opts: SendDocumentOpts): Promise<void> {
  const form = new FormData();
  form.append('chat_id', String(opts.chatId));
  form.append(
    'document',
    new Blob([opts.body], { type: opts.contentType }),
    opts.filename,
  );
  if (opts.caption) form.append('caption', opts.caption);
  if (opts.parseMode) form.append('parse_mode', opts.parseMode);
  if (opts.replyMarkup) form.append('reply_markup', JSON.stringify(opts.replyMarkup));

  const res = await fetch(apiUrl('sendDocument'), { method: 'POST', body: form });
  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) {
    throw new Error(`Telegram sendDocument failed: ${json.description ?? 'unknown'}`);
  }
}

/**
 * Set the bot's webhook URL. Call once when deploying a new environment.
 * After this, Telegram POSTs every message to the URL.
 */
export async function setWebhook(url: string, secretToken?: string): Promise<unknown> {
  const r = await fetch(apiUrl('setWebhook'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
    }),
  });
  return r.json();
}
