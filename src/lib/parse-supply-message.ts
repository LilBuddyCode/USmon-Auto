// src/lib/parse-supply-message.ts
// Free-text supply report → structured supply_request, via Claude Sonnet 4.6.
//
// Per ADR-008 Stage 1: techs and the buyer send casual messages like
// "low on dragonfly" or "out of single needles at lakeside send 20".
// Claude parses each into a strict JSON shape we store + reason over.
//
// Per ADR-005: this function also screens for PHI patterns in the message
// itself. If a tech accidentally includes a patient name, case ID, or surgeon
// reference, we reject the message and ask them to rephrase. PHI screening
// happens BEFORE the Claude call so we never send PHI to the model.

import Anthropic from '@anthropic-ai/sdk';
import { checkSampleRowsForPhi } from './phi-detector';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ParsedSupplyMessage {
  is_supply_report: boolean;
  item: string | null;             // canonical-ish, lowercase. e.g., "dragonfly probes"
  location_hint: string | null;    // e.g., "lakeside", "main office", "van 1"
  urgency: 'low' | 'medium' | 'high' | null;
  quantity: number | null;
  confidence: number;              // 0.0 - 1.0
  reasoning: string;               // 1 sentence from Claude
  non_supply_reason: string | null;
}

export interface ParseResult {
  ok: boolean;
  parsed?: ParsedSupplyMessage;
  phi_rejected?: boolean;
  phi_reason?: string;
  error?: string;
  model_used?: string;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
}

// ─── PHI screening for free-text ─────────────────────────────────────────────

// Patterns in MESSAGE BODIES that indicate PHI risk.
// More aggressive than column-header patterns — messages are unstructured
// so we need to match on phrases, not just identifier-style column names.
const MESSAGE_PHI_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bmrn[:\s#]*\d/i, reason: 'Looks like an MRN reference' },
  { pattern: /\bcase\s*(?:id|#|number)/i, reason: 'Case ID/number mention' },
  { pattern: /\bdr\.?\s+[a-z]+\s+(performed|did|operated|surgery)/i, reason: 'Surgeon-action reference' },
  { pattern: /\bpatient\s+[a-z]+/i, reason: 'Patient name reference' },
  { pattern: /\b(dob|date\s+of\s+birth)[:\s]/i, reason: 'Date-of-birth marker' },
  { pattern: /\bicd[\s-]*10[:\s]/i, reason: 'ICD-10 reference' },
  { pattern: /\bcpt\s*\d/i, reason: 'CPT code reference' },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, reason: 'SSN-pattern value' },
];

function screenMessageForPhi(text: string): { phi: boolean; reason?: string } {
  for (const { pattern, reason } of MESSAGE_PHI_PATTERNS) {
    if (pattern.test(text)) return { phi: true, reason };
  }
  return { phi: false };
}

// ─── Claude integration ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an inventory triage assistant for a medical IONM (intraoperative neuromonitoring) company. Operators send short, casual messages reporting that physical supplies are running low. Your job is to parse each message into strict JSON.

Common supplies in this industry: Cadwell Dragonfly probes, Ambu sticky pads, Ambu twisted pairs, Ambu single needles, ET tubes, disposable probes, electrodes.

Common location hints: hospital names (e.g., "Lakeside", "St. Mary's"), vehicles ("van 1", "main van"), generic ("warehouse", "main office", "back stock").

Rules:
- Output STRICT JSON only. No prose, no markdown, no code fences.
- "item" should be the most specific item name you can extract, lowercase. If the message says just "needles", say "needles" (don't guess). If it says "dragonfly probes", say "dragonfly probes".
- "location_hint" is the place name they mention, lowercase. null if none.
- "urgency" is "low" by default. Use "medium" if they say "soon" or "running out". Use "high" if they say "out", "urgent", "asap", "now", or similar.
- "quantity" is a number if they explicitly mention one ("send 20", "need 5"). Otherwise null.
- "confidence" is 0.0 to 1.0. High when the message is clearly a supply report. Low when ambiguous.
- "is_supply_report" is false if the message is clearly NOT a supply report (greeting, question, thanks, bot test, etc.). When false, fill "non_supply_reason" briefly.
- "reasoning" is 1 sentence explaining your interpretation. Keep it under 25 words.

Required JSON shape:
{
  "is_supply_report": boolean,
  "item": string | null,
  "location_hint": string | null,
  "urgency": "low" | "medium" | "high" | null,
  "quantity": number | null,
  "confidence": number,
  "reasoning": string,
  "non_supply_reason": string | null
}`;

const SONNET_INPUT_PER_MTOK_USD = 3.0;
const SONNET_OUTPUT_PER_MTOK_USD = 15.0;

export async function parseSupplyMessage(rawMessage: string): Promise<ParseResult> {
  const trimmed = rawMessage.trim();
  if (!trimmed) {
    return { ok: false, error: 'Empty message' };
  }

  // Layer 1: PHI screen on the raw message body BEFORE calling Claude.
  const phi = screenMessageForPhi(trimmed);
  if (phi.phi) {
    return {
      ok: false,
      phi_rejected: true,
      phi_reason: phi.reason ?? 'PHI pattern detected in message body',
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'ANTHROPIC_API_KEY not configured' };
  }

  const client = new Anthropic({ apiKey });

  // Use a stable model id. Per ADR-003 we picked Sonnet for reasoning quality
  // at a low per-call cost. Per Day 0 notes: ~$0.001-0.003 per parse expected.
  const model = 'claude-sonnet-4-5-20250929';

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 512, // bumped from 256 after first live test showed truncation mid-JSON
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Parse this message:\n\n${trimmed}`,
        },
      ],
    });
  } catch (err) {
    return {
      ok: false,
      error: `Claude API error: ${err instanceof Error ? err.message : 'unknown'}`,
      model_used: model,
    };
  }

  // Extract text content
  const textBlock = response.content.find((c): c is Anthropic.Messages.TextBlock => c.type === 'text');
  if (!textBlock) {
    return { ok: false, error: 'No text in Claude response', model_used: model };
  }

  // Sonnet sometimes wraps JSON in ```json...``` despite the system-prompt
  // "no code fences" rule. Strip defensively before parsing.
  function unfenceJson(s: string): string {
    let t = s.trim();
    // Common pattern: ```json\n{...}\n```
    const fenceMatch = t.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```$/);
    if (fenceMatch) return fenceMatch[1].trim();
    // Looser: starts with ``` and ends with ```
    if (t.startsWith('```')) t = t.replace(/^```(?:json|JSON)?\s*/i, '');
    if (t.endsWith('```')) t = t.replace(/\s*```\s*$/, '');
    return t.trim();
  }

  let parsed: ParsedSupplyMessage;
  try {
    parsed = JSON.parse(unfenceJson(textBlock.text));
  } catch (err) {
    return {
      ok: false,
      error: `Claude returned non-JSON: ${textBlock.text.slice(0, 200)}`,
      model_used: model,
    };
  }

  // Light validation
  if (typeof parsed.is_supply_report !== 'boolean') {
    return { ok: false, error: 'Parse missing is_supply_report', model_used: model };
  }

  // Layer 2: PHI screen on parsed output. The parser shouldn't reflect PHI back
  // (it can't introduce it that wasn't there), but defense in depth.
  if (parsed.item || parsed.location_hint) {
    const sample = [{ item: parsed.item ?? '', location_hint: parsed.location_hint ?? '' }];
    const check = checkSampleRowsForPhi(sample as Array<Record<string, string>>);
    if (!check.passed) {
      return {
        ok: false,
        phi_rejected: true,
        phi_reason: check.reason ?? 'Parsed output flagged for PHI',
        model_used: model,
      };
    }
  }

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const cost =
    (inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK_USD +
    (outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK_USD;

  return {
    ok: true,
    parsed,
    model_used: model,
    cost_usd: Number(cost.toFixed(5)),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}
