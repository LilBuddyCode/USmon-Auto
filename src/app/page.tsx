// src/app/page.tsx — public dashboard for the staging deploy.
// Pulls live stats from the DB and renders as a single page hiring managers can
// click around. No PHI is ever shown (per ADR-005). Aggregate counts only.

import { query } from '@/lib/db';

// Don't cache — show fresh numbers on each visit.
export const dynamic = 'force-dynamic';

interface Stats {
  items: number;
  locations: number;
  suppliers: number;
  supply_requests_total: number;
  supply_requests_24h: number;
  reorders_total: number;
  reorders_open: number;
  lot_numbers_logged: number;
}

interface RecentRequest {
  id: string;
  parsed_item: string;
  parsed_urgency: string | null;
  reporter_first_name: string | null;
  reported_at: string;
}

interface RecentReorder {
  id: string;
  item_name_snapshot: string;
  quantity_ordered: string | null;
  supplier_name_snapshot: string | null;
  lot_number: string | null;
  received_at: string | null;
  ordered_at: string;
}

async function loadStats(): Promise<Stats> {
  const r = await query<Stats>(`
    SELECT
      (SELECT COUNT(*)::int FROM items) AS items,
      (SELECT COUNT(*)::int FROM locations WHERE active = TRUE) AS locations,
      (SELECT COUNT(*)::int FROM suppliers WHERE active = TRUE) AS suppliers,
      (SELECT COUNT(*)::int FROM supply_requests WHERE is_supply_report = TRUE) AS supply_requests_total,
      (SELECT COUNT(*)::int FROM supply_requests WHERE is_supply_report = TRUE AND reported_at > NOW() - INTERVAL '24 hours') AS supply_requests_24h,
      (SELECT COUNT(*)::int FROM reorders) AS reorders_total,
      (SELECT COUNT(*)::int FROM reorders WHERE received_at IS NULL) AS reorders_open,
      (SELECT COUNT(*)::int FROM reorders WHERE lot_number IS NOT NULL) AS lot_numbers_logged
  `);
  return r.rows[0];
}

async function loadRecentRequests(): Promise<RecentRequest[]> {
  const r = await query<RecentRequest>(`
    SELECT id::text, parsed_item, parsed_urgency, reporter_first_name,
           TO_CHAR(reported_at, 'Mon DD HH24:MI') AS reported_at
    FROM supply_requests
    WHERE is_supply_report = TRUE
    ORDER BY reported_at DESC
    LIMIT 5
  `);
  return r.rows;
}

async function loadRecentReorders(): Promise<RecentReorder[]> {
  const r = await query<RecentReorder>(`
    SELECT id::text, item_name_snapshot, quantity_ordered::text,
           supplier_name_snapshot, lot_number,
           TO_CHAR(received_at, 'Mon DD') AS received_at,
           TO_CHAR(ordered_at, 'Mon DD') AS ordered_at
    FROM reorders
    ORDER BY ordered_at DESC
    LIMIT 6
  `);
  return r.rows;
}

// Re-usable bits
function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '16px 20px',
        minWidth: 130,
        flex: '1 1 130px',
      }}
    >
      <div style={{ fontSize: '0.75rem', color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: '1.85rem', fontWeight: 600, marginTop: 6 }}>{value}</div>
      {hint && <div style={{ fontSize: '0.78rem', color: 'var(--fg-muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function urgencyDot(urgency: string | null): string {
  if (urgency === 'high') return '🚨';
  if (urgency === 'medium') return '⏰';
  if (urgency === 'low') return '•';
  return '·';
}

export default async function HomePage() {
  let stats: Stats | null = null;
  let recentRequests: RecentRequest[] = [];
  let recentReorders: RecentReorder[] = [];
  let dbError: string | null = null;

  try {
    [stats, recentRequests, recentReorders] = await Promise.all([
      loadStats(),
      loadRecentRequests(),
      loadRecentReorders(),
    ]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'Unknown DB error';
  }

  const accent = { color: 'var(--accent)' };
  const sectionStyle = { marginTop: 48 };
  const h2Style = { fontSize: '1.25rem', fontWeight: 600, marginBottom: 12 };

  return (
    <main
      style={{
        maxWidth: 980,
        margin: '0 auto',
        padding: '48px 24px 96px',
        lineHeight: 1.55,
      }}
    >
      {/* ─── Hero ──────────────────────────────────────────────── */}
      <header>
        <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', letterSpacing: 1, textTransform: 'uppercase' }}>
          14-day production-grade FDE sprint
        </div>
        <h1 style={{ fontSize: '2.6rem', margin: '6px 0 12px', lineHeight: 1.1 }}>
          USmon-Auto
        </h1>
        <p style={{ fontSize: '1.05rem', color: 'var(--fg-muted)', maxWidth: 720, margin: 0 }}>
          Operational supply chain automation for IONM (intraoperative neuromonitoring)
          companies. Captures tech-reported low-stock messages via Telegram, consolidates
          them into a buyer-facing digest, helps order from suppliers, tracks lot numbers
          for JCAHO/FDA traceability, and bootstraps the customer&apos;s USmon Supply
          Inventory catalog over time. By design, zero patient data ever enters the system.
        </p>
      </header>

      {/* ─── Top stats ─────────────────────────────────────────── */}
      <section style={{ ...sectionStyle, marginTop: 32 }}>
        {dbError ? (
          <div
            style={{
              padding: 16,
              background: 'rgba(240,104,104,0.1)',
              border: '1px solid var(--err)',
              borderRadius: 8,
              color: 'var(--err)',
            }}
          >
            DB connection issue: {dbError}
          </div>
        ) : stats ? (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stat label="Items tracked" value={stats.items} />
            <Stat label="Locations" value={stats.locations} hint="techs as ship-to endpoints" />
            <Stat label="Suppliers" value={stats.suppliers} />
            <Stat label="Reports (24h)" value={stats.supply_requests_24h} hint={`${stats.supply_requests_total} all-time`} />
            <Stat label="Reorders" value={stats.reorders_total} hint={`${stats.reorders_open} pending receipt`} />
            <Stat label="Lots logged" value={stats.lot_numbers_logged} hint="JCAHO traceability" />
          </div>
        ) : null}
      </section>

      {/* ─── Try the bot ──────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Try the bot</h2>
        <p>
          The user-facing surface is a Telegram bot. Open{' '}
          <a href="https://t.me/usmon_auto_staging_bot" style={accent}>
            @usmon_auto_staging_bot
          </a>{' '}
          on your phone, tap <strong>START</strong>, then text it as if you were a tech
          reporting low stock — e.g. <code>low on parallel pair needles</code>. Try the{' '}
          <code>/menu</code> command for the buyer view (Today&apos;s list, Pending receipts,
          export to USmon, etc.).
        </p>
        <p style={{ fontSize: '0.9rem', color: 'var(--fg-muted)' }}>
          Note: this is the STAGING bot. Per <a href="https://github.com/LilBuddyCode/USmon-Auto/blob/main/docs/adr/007-staging-vs-production-bot.md" style={accent}>ADR-007</a>,
          the production bot stays dormant until the test plan checklist passes.
        </p>
      </section>

      {/* ─── Recent supply reports ─────────────────────────────── */}
      {recentRequests.length > 0 && (
        <section style={sectionStyle}>
          <h2 style={h2Style}>Recent supply reports (live)</h2>
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {recentRequests.map((r, i) => (
              <div
                key={r.id}
                style={{
                  padding: '12px 16px',
                  borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                  display: 'flex',
                  gap: 12,
                  alignItems: 'baseline',
                }}
              >
                <span style={{ fontSize: '1.1rem', width: 18 }}>{urgencyDot(r.parsed_urgency)}</span>
                <span style={{ flex: 1 }}>{r.parsed_item}</span>
                <span style={{ color: 'var(--fg-muted)', fontSize: '0.85rem' }}>
                  by {r.reporter_first_name ?? 'anon'} · {r.reported_at}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ─── Reorders ──────────────────────────────────────────── */}
      {recentReorders.length > 0 && (
        <section style={sectionStyle}>
          <h2 style={h2Style}>Reorders (live)</h2>
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 0.7fr 1.6fr 1fr 0.9fr', gap: 12, padding: '10px 16px', fontSize: '0.75rem', color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              <div>Item</div>
              <div>Qty</div>
              <div>Supplier</div>
              <div>Lot</div>
              <div>Status</div>
            </div>
            {recentReorders.map((r) => (
              <div
                key={r.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 0.7fr 1.6fr 1fr 0.9fr',
                  gap: 12,
                  padding: '10px 16px',
                  borderTop: '1px solid var(--border)',
                  fontSize: '0.9rem',
                }}
              >
                <div>{r.item_name_snapshot}</div>
                <div>{r.quantity_ordered ?? '—'}</div>
                <div style={{ color: 'var(--fg-muted)' }}>{r.supplier_name_snapshot ?? '—'}</div>
                <div style={{ fontFamily: 'monospace', color: r.lot_number ? 'var(--ok)' : 'var(--fg-muted)' }}>
                  {r.lot_number ?? '—'}
                </div>
                <div style={{ color: r.received_at ? 'var(--ok)' : 'var(--warn)' }}>
                  {r.received_at ? `✓ ${r.received_at}` : `⏳ open`}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ─── Architecture ──────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Architecture</h2>
        <pre style={{ fontSize: '0.8rem' }}>
{`Telegram bot (@usmon_auto_staging_bot)
        │
        │ webhook
        ▼
┌───────────────────────┐
│   Vercel (Next.js 15) │
│  /api/telegram/webhook│  ← receives every bot message
│  /api/ingest          │  ← legacy CSV upload (USmon Stage 3)
│  /api/jobs/morning-…  │  ← Vercel Cron 8 AM EST daily
│  /api/export/usmon-…  │  ← Stage 2 catalog bridge
│  /api/admin/migrate   │  ← idempotent schema apply
│  /api/admin/seed      │  ← real catalog seed ([product line])
│  /api/admin/run-eval  │  ← 18-case parser eval
│  /api/health          │  ← build hash + DB ping
└─────┬────────────┬────┘
      │            │
      ▼            ▼
┌──────────────┐ ┌────────────────────┐
│ Neon         │ │ Anthropic API      │
│ Postgres 16  │ │ Claude Sonnet 4.5  │
│ 12 tables    │ │ ~$0.003 per parse  │
│ Zero PHI     │ │ ~$0.05 per eval    │
└──────────────┘ └────────────────────┘`}
        </pre>
      </section>

      {/* ─── Docs ──────────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Read the work</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, lineHeight: 1.9 }}>
          <li>
            📂 <a href="https://github.com/LilBuddyCode/USmon-Auto" style={accent}>github.com/LilBuddyCode/USmon-Auto</a> — the source
          </li>
          <li>
            📜 <a href="https://github.com/LilBuddyCode/USmon-Auto/blob/main/BUILD-LOG.md" style={accent}>BUILD-LOG.md</a> — day-by-day narrative of what shipped, what broke, what was learned
          </li>
          <li>
            🏗️ <a href="https://github.com/LilBuddyCode/USmon-Auto/tree/main/docs/adr" style={accent}>docs/adr/</a> — 9 ADRs documenting architecture decisions and trade-offs
          </li>
          <li>
            🧪 <a href="https://github.com/LilBuddyCode/USmon-Auto/blob/main/docs/EVAL-RESULTS.md" style={accent}>EVAL-RESULTS.md</a> — 18-case parser eval with per-category breakdown
          </li>
          <li>
            🛡️ <a href="https://github.com/LilBuddyCode/USmon-Auto/blob/main/docs/BACKUP-AND-ROLLBACK.md" style={accent}>BACKUP-AND-ROLLBACK.md</a> — disaster recovery procedures (5 scenarios)
          </li>
          <li>
            🔬 <a href="https://github.com/LilBuddyCode/USmon-Auto/blob/main/test-fixtures/supply-message-eval-set.json" style={accent}>supply-message-eval-set.json</a> — the 18 hand-labeled fixture cases
          </li>
        </ul>
      </section>

      {/* ─── Footer ────────────────────────────────────────────── */}
      <footer style={{ marginTop: 64, paddingTop: 24, borderTop: '1px solid var(--border)', fontSize: '0.85rem', color: 'var(--fg-muted)' }}>
        Built solo in a 14-day production sprint as an FDE portfolio piece.
        Real customer (the customer). Real data ([product line] SKUs from
        Primary Supplier). Real compliance boundary (PHI rejection at
        6 layers, tested adversarially).
      </footer>
    </main>
  );
}
