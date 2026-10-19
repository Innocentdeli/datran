-- 0003: plans & quotas, usage accounting, credit ledger integrity, Stripe billing state, mobile refresh tokens.
-- Timestamps are BIGINT epoch milliseconds (project convention). Byte counters are BIGINT.

-- ---------------------------------------------------------------------------------------------------------------
-- Credits: exact decimal amounts (REAL lost precision for fractional per-GB debits), a hard non-negative balance,
-- and idempotency keys on every ledger entry (a retried webhook / request can never double-credit or double-debit).
-- ---------------------------------------------------------------------------------------------------------------
UPDATE user_credits SET balance = 0 WHERE balance < 0;
ALTER TABLE user_credits
  ALTER COLUMN balance TYPE NUMERIC(20, 6),
  ALTER COLUMN total_earned TYPE NUMERIC(20, 6),
  ALTER COLUMN total_spent TYPE NUMERIC(20, 6);
ALTER TABLE user_credits ADD CONSTRAINT user_credits_balance_nonnegative CHECK (balance >= 0);

ALTER TABLE credit_ledger ALTER COLUMN amount TYPE NUMERIC(20, 6);
ALTER TABLE credit_ledger ADD COLUMN idempotency_key TEXT;
ALTER TABLE credit_ledger ADD COLUMN balance_after NUMERIC(20, 6);
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_idempotency_key_key UNIQUE (idempotency_key);
CREATE INDEX idx_credit_ledger_user_time ON credit_ledger(user_id, timestamp DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- Stripe: customer per user, local copy of subscription state (entitlement is derived from it, never from the
-- client-side checkout redirect), processed webhook events (idempotency), credit-pack purchases (refund clawback).
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD CONSTRAINT users_stripe_customer_id_key UNIQUE (stripe_customer_id);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,                      -- Stripe subscription id (sub_...)
  user_id TEXT NOT NULL,
  stripe_customer_id TEXT,
  status TEXT NOT NULL,                     -- Stripe status: active, trialing, past_due, canceled, unpaid, ...
  plan TEXT NOT NULL DEFAULT 'pro',
  billing_interval TEXT,                    -- month | year
  price_id TEXT,
  current_period_end BIGINT,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  past_due_since BIGINT,                    -- first failed payment of the current dunning cycle (grace period start)
  event_created BIGINT NOT NULL DEFAULT 0,  -- Stripe event.created (ms) of the last applied update: stale events are ignored
  updated_at BIGINT NOT NULL,
  CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);

CREATE TABLE processed_events (
  id TEXT PRIMARY KEY,                      -- Stripe event id (evt_...)
  type TEXT NOT NULL,
  processed_at BIGINT NOT NULL
);

CREATE TABLE credit_purchases (
  payment_intent TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  checkout_session TEXT UNIQUE,
  credits NUMERIC(20, 6) NOT NULL,
  amount_paid BIGINT NOT NULL,              -- smallest currency unit
  clawed_back NUMERIC(20, 6) NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  CONSTRAINT credit_purchases_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------------------------------------------
-- Usage accounting. user_usage: current storage of a user's live files (added on finalize, subtracted on delete /
-- expiry). usage_monthly: per calendar month (UTC, 'YYYY-MM'); subject = user id, or 'anon:<share_id>' for
-- anonymous uploads. Egress is batched in the shared KV and flushed here by the leader.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE user_usage (
  user_id TEXT PRIMARY KEY,
  storage_bytes BIGINT NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  uploads_count BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

CREATE TABLE usage_monthly (
  subject TEXT NOT NULL,
  period TEXT NOT NULL,
  egress_bytes BIGINT NOT NULL DEFAULT 0,
  credited_egress_bytes BIGINT NOT NULL DEFAULT 0,  -- egress paid for with credits (does not count against the quota)
  uploads_count BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (subject, period)
);

-- Existing files count towards their owner's storage from day one.
INSERT INTO user_usage (user_id, storage_bytes, uploads_count, updated_at)
SELECT user_id, COALESCE(SUM(file_size), 0), COUNT(*), (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
FROM files WHERE user_id IS NOT NULL GROUP BY user_id;

-- ---------------------------------------------------------------------------------------------------------------
-- Mobile refresh tokens (POST /api/mobile/token): only SHA-256 hashes are stored. Rotation keeps the family; a
-- second use of a rotated token revokes the whole family (token theft detection).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  rotated_at BIGINT,
  replaced_by TEXT,
  revoked_at BIGINT,
  CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at);
