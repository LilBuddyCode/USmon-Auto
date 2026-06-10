// src/app/api/admin/run-eval/route.ts
// Eval suite runner — executes all hand-labeled fixture cases against the
// live parser, compares output to expected, returns precision/recall and
// per-case breakdowns.
//
// Each run also gets logged to the eval_runs table for trend tracking
// (Day 9 of the 14-day sprint plan).
//
// Cost: each case is one Claude API call. With 18 cases at ~$0.002/call,
// full run costs ~$0.04 of API spend.
//
// Auth: ?password=[DASHBOARD_PASSWORD]

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSupplyMessage } from '@/lib/parse-supply-message';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 18 cases × ~2s each = ~36s

function authorized(req: NextRequest): boolean {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return false;
  const url = new URL(req.url);
  if (url.searchParams.get('password') === expected) return true;
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${expected}`;
}

interface ExpectedShape {
  is_supply_report?: boolean;
  item?: string | null;
  item_match_one_of?: string[];
  location_hint?: string | null;
  urgency?: string | null;
  quantity?: number | null;
  min_confidence?: number;
  phi_rejected_pre_claude?: boolean;
  phi_reason_contains?: string;
}

interface FixtureCase {
  id: string;
  raw: string;
  expected: ExpectedShape;
  category: string;
}

interface EvalCaseResult {
  id: string;
  category: string;
  raw: string;
  pass: boolean;
  failures: string[];
  parsed: unknown;
  phi_rejected?: boolean;
  cost_usd?: number;
  ms?: number;
}

function getFixtures(): FixtureCase[] {
  const path = join(process.cwd(), 'test-fixtures', 'supply-message-eval-set.json');
  const json = JSON.parse(readFileSync(path, 'utf-8')) as { cases: FixtureCase[] };
  return json.cases;
}

function evalCase(
  raw: string,
  expected: ExpectedShape,
  result: Awaited<ReturnType<typeof parseSupplyMessage>>,
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];

  // PHI rejection check
  if (expected.phi_rejected_pre_claude) {
    if (!result.phi_rejected) {
      failures.push('expected PHI rejection but parser accepted');
    } else if (
      expected.phi_reason_contains &&
      !(result.phi_reason ?? '').toLowerCase().includes(expected.phi_reason_contains.toLowerCase())
    ) {
      failures.push(
        `PHI reason "${result.phi_reason}" did not contain "${expected.phi_reason_contains}"`,
      );
    }
    return { pass: failures.length === 0, failures };
  }

  if (result.phi_rejected) {
    failures.push(`unexpected PHI rejection: ${result.phi_reason}`);
    return { pass: false, failures };
  }

  if (!result.ok || !result.parsed) {
    failures.push(`parser error: ${result.error ?? 'unknown'}`);
    return { pass: false, failures };
  }

  const p = result.parsed;

  if (expected.is_supply_report !== undefined && p.is_supply_report !== expected.is_supply_report) {
    failures.push(
      `is_supply_report: expected ${expected.is_supply_report}, got ${p.is_supply_report}`,
    );
  }

  if (expected.item !== undefined && expected.item !== null) {
    // Fuzzy item match (substring, case-insensitive)
    if (!p.item || !p.item.toLowerCase().includes(expected.item.toLowerCase())) {
      failures.push(`item: expected "${expected.item}" substring, got "${p.item}"`);
    }
  }

  if (expected.item_match_one_of) {
    const matched = expected.item_match_one_of.some(
      (alt) => p.item && p.item.toLowerCase().includes(alt.toLowerCase()),
    );
    if (!matched) {
      failures.push(
        `item: expected one of [${expected.item_match_one_of.join(', ')}], got "${p.item}"`,
      );
    }
  }

  if (expected.location_hint !== undefined && expected.location_hint !== null) {
    if (
      !p.location_hint ||
      !p.location_hint.toLowerCase().includes(expected.location_hint.toLowerCase())
    ) {
      failures.push(
        `location_hint: expected "${expected.location_hint}", got "${p.location_hint}"`,
      );
    }
  }

  if (expected.urgency !== undefined && expected.urgency !== null) {
    if (p.urgency !== expected.urgency) {
      failures.push(`urgency: expected "${expected.urgency}", got "${p.urgency}"`);
    }
  }

  if (expected.quantity !== undefined && expected.quantity !== null) {
    if (p.quantity !== expected.quantity) {
      failures.push(`quantity: expected ${expected.quantity}, got ${p.quantity}`);
    }
  }

  if (expected.min_confidence !== undefined) {
    if (p.confidence < expected.min_confidence) {
      failures.push(
        `confidence: expected >= ${expected.min_confidence}, got ${p.confidence.toFixed(2)}`,
      );
    }
  }

  return { pass: failures.length === 0, failures };
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let cases: FixtureCase[];
  try {
    cases = getFixtures();
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `Could not read fixtures: ${err instanceof Error ? err.message : 'unknown'}`,
      },
      { status: 500 },
    );
  }

  const start = Date.now();
  const results: EvalCaseResult[] = [];
  let totalCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const c of cases) {
    const caseStart = Date.now();
    const result = await parseSupplyMessage(c.raw);
    const { pass, failures } = evalCase(c.raw, c.expected, result);

    if (result.cost_usd) totalCost += result.cost_usd;
    if (result.input_tokens) inputTokens += result.input_tokens;
    if (result.output_tokens) outputTokens += result.output_tokens;

    results.push({
      id: c.id,
      category: c.category,
      raw: c.raw,
      pass,
      failures,
      parsed: result.parsed,
      phi_rejected: result.phi_rejected,
      cost_usd: result.cost_usd,
      ms: Date.now() - caseStart,
    });
  }

  const totalMs = Date.now() - start;
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const passRate = results.length > 0 ? passed / results.length : 0;

  // Group results by category for trend analysis
  const byCategory: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { pass: 0, total: 0 };
    byCategory[r.category].total += 1;
    if (r.pass) byCategory[r.category].pass += 1;
  }

  // Log to eval_runs for trend tracking
  try {
    await query(
      `INSERT INTO eval_runs
        (git_sha, precision_score, recall_score, mae_days, false_positive_rate,
         total_predictions, fixture_set, notes)
       VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6)`,
      [
        process.env.VERCEL_GIT_COMMIT_SHA ?? 'local',
        Number(passRate.toFixed(4)),
        Number((failed / results.length).toFixed(4)),
        results.length,
        'supply-message-eval-set v0.1',
        `passed=${passed}, failed=${failed}, cost=$${totalCost.toFixed(4)}, tokens_in=${inputTokens}, tokens_out=${outputTokens}`,
      ],
    );
  } catch {
    // Don't fail the eval response if the log write fails
  }

  return NextResponse.json({
    ok: true,
    summary: {
      total_cases: results.length,
      passed,
      failed,
      pass_rate: Number(passRate.toFixed(4)),
      total_cost_usd: Number(totalCost.toFixed(4)),
      total_ms: totalMs,
      avg_ms_per_case: Math.round(totalMs / results.length),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      model_used: results[0]?.parsed
        ? (results[0].parsed as { reasoning?: string }).reasoning
          ? 'claude-sonnet-4-5'
          : 'unknown'
        : 'unknown',
    },
    by_category: byCategory,
    cases: results,
  });
}
