-- USmon-Auto database schema — Day 1 minimum viable
-- Postgres 15+. Topologically ordered: no forward references.
-- Per ADR-005: NO patient identifiers, NO case IDs, NO dates of service.
--
-- This file is the source of truth. Paste it into Neon SQL Editor and Run.

-- ============================================================
-- LOCATIONS — warehouse, van, clinic where stock lives
-- ============================================================
CREATE TABLE IF NOT EXISTS locations (
  id                  SERIAL PRIMARY KEY,
  usmon_location_id   VARCHAR(64) UNIQUE,                 -- raw ID from USmon
  name                VARCHAR(256) NOT NULL,
  kind                VARCHAR(32),                         -- warehouse, van, clinic, kit
  active              BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_locations_active ON locations(active) WHERE active = TRUE;

-- ============================================================
-- ITEMS — supply catalog
-- Natural key: (name, manufacturer). USmon's "Manufacture" typo is normalized here.
-- ============================================================
CREATE TABLE IF NOT EXISTS items (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(256) NOT NULL,
  manufacturer        VARCHAR(256) NOT NULL DEFAULT '',
  manufacturer_number VARCHAR(128),
  category            VARCHAR(128),
  unit_of_measure     VARCHAR(32),
  reorder_point       INTEGER,                             -- nullable until learned/set
  expiration_sensitive BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT items_name_manufacturer_unique UNIQUE (name, manufacturer)
);

CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);

-- ============================================================
-- CSV_IMPORTS — audit trail for every upload
-- ============================================================
CREATE TABLE IF NOT EXISTS csv_imports (
  id                  SERIAL PRIMARY KEY,
  source_filename     VARCHAR(512) NOT NULL,
  row_count           INTEGER NOT NULL DEFAULT 0,
  rows_rejected       INTEGER NOT NULL DEFAULT 0,
  phi_check_passed    BOOLEAN NOT NULL DEFAULT TRUE,
  phi_check_details   JSONB,
  raw_csv_sha256      CHAR(64),                            -- for dedup, not raw content
  notes               TEXT,
  ingested_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_csv_imports_ingested_at ON csv_imports(ingested_at DESC);

-- ============================================================
-- DAILY_COUNTS — time-series stock snapshots
-- One row per CSV ingest per (item, location). NO patient linkage.
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_counts (
  id                  BIGSERIAL PRIMARY KEY,
  item_id             INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  location_id         INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quantity            INTEGER NOT NULL,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  csv_import_id       INTEGER REFERENCES csv_imports(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_counts_item_date ON daily_counts(item_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_counts_location_date ON daily_counts(location_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_counts_import ON daily_counts(csv_import_id);

-- ============================================================
-- MANUFACTURERS — supplier directory (used Day 5+ for vendor comparison)
-- Not required by Day 1 ingest. Created here for upcoming work.
-- ============================================================
CREATE TABLE IF NOT EXISTS manufacturers (
  id                      SERIAL PRIMARY KEY,
  name                    VARCHAR(256) NOT NULL UNIQUE,
  website                 VARCHAR(512),
  contact_email           VARCHAR(256),
  contact_phone           VARCHAR(64),
  typical_lead_time_days  INTEGER,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PREDICTIONS — output of Claude reorder prediction calls (Day 7+)
-- ============================================================
CREATE TABLE IF NOT EXISTS predictions (
  id                    SERIAL PRIMARY KEY,
  item_id               INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  location_id           INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  predicted_at          TIMESTAMPTZ DEFAULT NOW(),
  days_until_stockout   NUMERIC(6,1),
  confidence_band       VARCHAR(16),                       -- high, medium, low
  suggested_order_qty   INTEGER,
  reasoning_text        TEXT,
  claude_input_hash     CHAR(40),
  claude_input_jsonb    JSONB,
  claude_output_jsonb   JSONB,
  model_used            VARCHAR(64),
  cost_usd              NUMERIC(8,4)
);

CREATE INDEX IF NOT EXISTS idx_predictions_item_date ON predictions(item_id, predicted_at DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_hash ON predictions(claude_input_hash);

-- ============================================================
-- ALERTS — every Telegram alert we send (Day 6+)
-- ============================================================
CREATE TABLE IF NOT EXISTS alerts (
  id                  SERIAL PRIMARY KEY,
  fired_at            TIMESTAMPTZ DEFAULT NOW(),
  channel             VARCHAR(16) NOT NULL DEFAULT 'telegram',
  tier                INTEGER NOT NULL,                    -- 1 urgent, 2 soon, 3 watch
  item_id             INTEGER REFERENCES items(id) ON DELETE SET NULL,
  prediction_id       INTEGER REFERENCES predictions(id) ON DELETE SET NULL,
  body                TEXT NOT NULL,
  telegram_message_id BIGINT,
  delivery_status     VARCHAR(32),
  responded_at        TIMESTAMPTZ,
  response_text       TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_fired_at ON alerts(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_item ON alerts(item_id);

-- ============================================================
-- EVAL_RUNS — eval suite results for trend tracking (Day 9+)
-- ============================================================
CREATE TABLE IF NOT EXISTS eval_runs (
  id                  SERIAL PRIMARY KEY,
  ran_at              TIMESTAMPTZ DEFAULT NOW(),
  git_sha             VARCHAR(40),
  precision_score     NUMERIC(5,4),
  recall_score        NUMERIC(5,4),
  mae_days            NUMERIC(6,2),
  false_positive_rate NUMERIC(5,4),
  total_predictions   INTEGER,
  fixture_set         VARCHAR(64),
  notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_ran_at ON eval_runs(ran_at DESC);

-- ============================================================
-- TELEGRAM_USERS — known senders to the bot
-- Per ADR-008: capture-first ingest from techs and the buyer.
-- ============================================================
CREATE TABLE IF NOT EXISTS telegram_users (
  id                  SERIAL PRIMARY KEY,
  telegram_user_id    BIGINT NOT NULL UNIQUE,
  telegram_chat_id    BIGINT NOT NULL,
  first_name          VARCHAR(128),
  username            VARCHAR(64),
  role                VARCHAR(16) NOT NULL DEFAULT 'tech',  -- 'tech', 'buyer', 'observer'
  active              BOOLEAN DEFAULT TRUE,
  first_seen_at       TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_users_role ON telegram_users(role) WHERE active = TRUE;

-- ============================================================
-- SUPPLIERS — vendor directory
-- Per ADR-008 Stage 1: bot can say "call Maria at MedSupply".
-- ============================================================
CREATE TABLE IF NOT EXISTS suppliers (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(256) NOT NULL,                  -- company name
  contact_name        VARCHAR(128),                            -- person Toya calls
  phone               VARCHAR(64),
  email               VARCHAR(256),
  typical_lead_hours  INTEGER,                                 -- 4 for same-day, 24 for next-day
  notes               TEXT,
  active              BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SUPPLY_REQUESTS — capture-first ingest of low-stock reports
-- Free-text from a tech (or self-report from Toya), parsed by Claude
-- into a structured supply event. Per ADR-008 Stage 1.
-- ============================================================
CREATE TABLE IF NOT EXISTS supply_requests (
  id                      BIGSERIAL PRIMARY KEY,
  -- Source
  telegram_user_id        BIGINT NOT NULL,                     -- raw, may reference telegram_users.telegram_user_id
  telegram_chat_id        BIGINT NOT NULL,
  telegram_message_id     BIGINT,
  reporter_first_name     VARCHAR(128),                        -- snapshot, in case profile changes
  -- Raw input
  raw_message             TEXT NOT NULL,
  reported_at             TIMESTAMPTZ DEFAULT NOW(),
  -- Parsed output (Claude)
  is_supply_report        BOOLEAN NOT NULL DEFAULT TRUE,       -- false = noise / non-supply chatter
  parsed_item             VARCHAR(256),                         -- canonical-ish, lowercase
  parsed_location_hint    VARCHAR(256),                         -- e.g., "lakeside", "van 1", null
  parsed_urgency          VARCHAR(16),                          -- 'low', 'medium', 'high'
  parsed_quantity         INTEGER,                              -- if explicitly mentioned
  parse_confidence        NUMERIC(3,2),                         -- 0.00-1.00
  parse_reasoning         TEXT,                                 -- 1-sentence justification from Claude
  parse_model             VARCHAR(64),                          -- 'claude-sonnet-4-6'
  parse_raw_jsonb         JSONB,                                -- full parse response for debug + audit
  parse_cost_usd          NUMERIC(8,5),                         -- per-call cost
  -- Linkage
  item_id                 INTEGER REFERENCES items(id) ON DELETE SET NULL,        -- fuzzy-matched canonical item
  location_id             INTEGER REFERENCES locations(id) ON DELETE SET NULL,    -- fuzzy-matched location
  superseded_by_reorder_id INTEGER                                                 -- forward ref, see below
);

CREATE INDEX IF NOT EXISTS idx_supply_requests_reported_at ON supply_requests(reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_supply_requests_item ON supply_requests(item_id);
CREATE INDEX IF NOT EXISTS idx_supply_requests_user ON supply_requests(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_supply_requests_unhandled
  ON supply_requests(reported_at DESC)
  WHERE superseded_by_reorder_id IS NULL AND is_supply_report = TRUE;

-- ============================================================
-- REORDERS — Toya's "I called the supplier about this" log
-- Per ADR-008 Stage 1.
-- ============================================================
CREATE TABLE IF NOT EXISTS reorders (
  id                          SERIAL PRIMARY KEY,
  item_id                     INTEGER REFERENCES items(id) ON DELETE SET NULL,
  item_name_snapshot          VARCHAR(256) NOT NULL,            -- preserves the name at time of order
  supplier_id                 INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_name_snapshot      VARCHAR(256),
  quantity_ordered            INTEGER,
  unit_price_cents            INTEGER,                          -- optional, if she remembers/tracks
  ordered_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ordered_by_telegram_user_id BIGINT NOT NULL,                  -- usually Toya
  expected_delivery_at        TIMESTAMPTZ,                      -- if she knows
  received_at                 TIMESTAMPTZ,                      -- null until marked received
  received_by_telegram_user_id BIGINT,
  follow_up_at                TIMESTAMPTZ,                      -- auto = ordered_at + 24h; bot pings if null received_at
  notes                       TEXT,
  source_request_count        INTEGER NOT NULL DEFAULT 1        -- how many supply_requests this consolidated
);

CREATE INDEX IF NOT EXISTS idx_reorders_ordered_at ON reorders(ordered_at DESC);
CREATE INDEX IF NOT EXISTS idx_reorders_open ON reorders(ordered_at DESC) WHERE received_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reorders_followup ON reorders(follow_up_at) WHERE received_at IS NULL;

-- Now safe to wire the forward ref from supply_requests
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'supply_requests_superseded_fk'
  ) THEN
    ALTER TABLE supply_requests
      ADD CONSTRAINT supply_requests_superseded_fk
      FOREIGN KEY (superseded_by_reorder_id)
      REFERENCES reorders(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================
-- DAY 5 — Pending action state + lot number capture
-- Adds idempotently so re-running schema.sql is safe.
-- ============================================================
ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS pending_action VARCHAR(64);
ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS pending_target_id BIGINT;
ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS pending_action_expires_at TIMESTAMPTZ;

ALTER TABLE reorders ADD COLUMN IF NOT EXISTS lot_number VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_telegram_users_pending
  ON telegram_users(telegram_user_id)
  WHERE pending_action IS NOT NULL;

-- ============================================================
-- SAFETY CHECK — ADR-005 boundary
-- This schema contains zero columns named for patient identifiers.
-- If you find one being added, ABORT.
-- Search for these patterns before any future migration is approved:
--   patient, mrn, case_id, dob, ssn, dos, surgeon, npi, procedure_code, icd
-- New tables (telegram_users, suppliers, supply_requests, reorders) per ADR-008
-- are operational-only. They store who messaged what about which item — never
-- linked to procedures, patients, or clinical events. Free-text fields
-- (raw_message, parse_reasoning, notes) are screened by the PHI detector on
-- ingest just like CSV columns.
-- ============================================================
