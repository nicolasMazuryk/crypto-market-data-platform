-- Migration 0000: initial schema for execution engine persistence

CREATE TYPE engine_mode AS ENUM ('live', 'dry_run', 'drain_only', 'halted');
CREATE TYPE intent_status AS ENUM (
  'decided', 'submitted', 'acked', 'working', 'partially_filled', 'filled',
  'monitoring', 'exiting', 'exited', 'error', 'cancelled'
);
CREATE TYPE order_status AS ENUM ('new', 'partially_filled', 'filled', 'cancelled', 'rejected', 'expired');
CREATE TYPE ops_event_level AS ENUM ('debug', 'info', 'warn', 'error', 'fatal');
CREATE TYPE snapshot_reason AS ENUM ('pre_funding', 'post_funding', 'reconcile', 'exit', 'periodic');

CREATE TABLE runs (
  id           TEXT PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ,
  mode         engine_mode NOT NULL,
  config_hash  TEXT NOT NULL DEFAULT '',
  git_sha      TEXT NOT NULL DEFAULT '',
  notes        TEXT
);

CREATE TABLE trade_intents (
  id                   TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES runs(id),
  strategy             TEXT NOT NULL,
  exchange             TEXT NOT NULL,
  symbol               TEXT NOT NULL,
  side                 TEXT NOT NULL,
  amount_usd           TEXT NOT NULL,
  leverage             INTEGER NOT NULL,
  funding_rate         TEXT NOT NULL,
  funding_rate_percent TEXT NOT NULL,
  funding_interval     INTEGER NOT NULL,
  next_funding_ts      TIMESTAMPTZ NOT NULL,
  decided_at           TIMESTAMPTZ NOT NULL,
  status               intent_status NOT NULL DEFAULT 'decided',
  decision_reason      TEXT,
  funding_snapshot     JSONB
);

CREATE INDEX idx_ti_run_exchange_status ON trade_intents (run_id, exchange, status);
CREATE INDEX idx_ti_next_funding_ts     ON trade_intents (next_funding_ts);

CREATE TABLE orders (
  id                TEXT PRIMARY KEY,
  intent_id         TEXT NOT NULL REFERENCES trade_intents(id),
  exchange          TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  client_order_id   TEXT NOT NULL,
  exchange_order_id TEXT,
  side              TEXT NOT NULL,
  type              TEXT NOT NULL,
  reduce_only       BOOLEAN NOT NULL DEFAULT false,
  qty               TEXT NOT NULL,
  price             TEXT,
  status            order_status NOT NULL DEFAULT 'new',
  submitted_at      TIMESTAMPTZ NOT NULL,
  acked_at          TIMESTAMPTZ,
  terminal_at       TIMESTAMPTZ,
  raw_snapshot      JSONB,
  CONSTRAINT uq_orders_exchange_client_order_id UNIQUE (exchange, client_order_id)
);

CREATE INDEX idx_orders_intent_id      ON orders (intent_id);
CREATE INDEX idx_orders_exchange_status ON orders (exchange, status);

CREATE TABLE fills (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id),
  exchange         TEXT NOT NULL,
  exchange_fill_id TEXT NOT NULL,
  qty              TEXT NOT NULL,
  price            TEXT NOT NULL,
  fee_asset        TEXT NOT NULL,
  fee_amount       TEXT NOT NULL,
  is_maker         BOOLEAN NOT NULL,
  ts               TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_fills_exchange_fill_id UNIQUE (exchange, exchange_fill_id)
);

CREATE INDEX idx_fills_order_id ON fills (order_id);

CREATE TABLE positions_history (
  id              TEXT PRIMARY KEY,
  exchange        TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  qty             TEXT NOT NULL,
  entry_price     TEXT,
  mark_price      TEXT,
  leverage        INTEGER NOT NULL,
  snapshot_reason snapshot_reason NOT NULL,
  ts              TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_positions_history_exchange_symbol_ts ON positions_history (exchange, symbol, ts);

CREATE TABLE balances_history (
  id        TEXT PRIMARY KEY,
  exchange  TEXT NOT NULL,
  asset     TEXT NOT NULL,
  available TEXT NOT NULL,
  locked    TEXT NOT NULL,
  ts        TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_balances_history_exchange_asset_ts ON balances_history (exchange, asset, ts);

CREATE TABLE funding_attributions (
  id             TEXT PRIMARY KEY,
  exchange       TEXT NOT NULL,
  symbol         TEXT NOT NULL,
  position_id    TEXT,
  funding_time   TIMESTAMPTZ NOT NULL,
  funding_rate   TEXT NOT NULL,
  funding_amount TEXT NOT NULL,
  asset          TEXT NOT NULL,
  ts             TIMESTAMPTZ NOT NULL
);

-- Partial unique indexes to handle nullable position_id correctly
CREATE UNIQUE INDEX uq_funding_attr_with_pos
  ON funding_attributions (exchange, symbol, funding_time, position_id)
  WHERE position_id IS NOT NULL;
CREATE UNIQUE INDEX uq_funding_attr_no_pos
  ON funding_attributions (exchange, symbol, funding_time)
  WHERE position_id IS NULL;

CREATE INDEX idx_funding_attr_exchange_symbol_ts ON funding_attributions (exchange, symbol, funding_time);

CREATE TABLE ops_events (
  id         TEXT PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL,
  level      ops_event_level NOT NULL,
  exchange   TEXT,
  event_type TEXT NOT NULL,
  payload    JSONB
);

CREATE INDEX idx_ops_events_ts                 ON ops_events (ts);
CREATE INDEX idx_ops_events_exchange_event_type ON ops_events (exchange, event_type);
