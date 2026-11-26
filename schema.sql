-- Runs safely on every start (all statements are IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'seller' CHECK (role IN ('seller','admin')),
  name            TEXT NOT NULL,
  shop_name       TEXT,
  phone           TEXT,
  category        TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','suspended')),
  commission_rate NUMERIC(5,2) NOT NULL DEFAULT 15 CHECK (commission_rate >= 0 AND commission_rate <= 100),
  payout_method   TEXT,
  payout_details  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_shop_uq  ON users (lower(shop_name)) WHERE shop_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS payouts (
  id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), amount_cents INTEGER NOT NULL,
  currency TEXT, method TEXT, reference TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS earnings (
  id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), order_id TEXT NOT NULL, order_name TEXT,
  order_date TIMESTAMPTZ, currency TEXT, kind TEXT NOT NULL CHECK (kind IN ('sale','refund')), source_id TEXT NOT NULL,
  gross_cents INTEGER NOT NULL, rate NUMERIC(5,2) NOT NULL, commission_cents INTEGER NOT NULL,
  earning_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid')),
  payout_id INTEGER REFERENCES payouts(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (source_id,user_id,kind)
);
CREATE INDEX IF NOT EXISTS earnings_user_idx ON earnings (user_id,status);
CREATE TABLE IF NOT EXISTS processed_webhooks (id TEXT PRIMARY KEY, topic TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS "session" ("sid" VARCHAR NOT NULL PRIMARY KEY, "sess" JSON NOT NULL, "expire" TIMESTAMP(6) NOT NULL);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('seller','admin','employee'));

CREATE TABLE IF NOT EXISTS seller_tiktok_ads (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_ciphertext TEXT NOT NULL, token_iv TEXT NOT NULL, token_auth_tag TEXT NOT NULL,
  advertiser_ids JSONB NOT NULL DEFAULT '[]'::jsonb, connected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS seller_ad_accounts (
  id SERIAL PRIMARY KEY, seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','meta','tiktok')), access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT, expires_at TIMESTAMPTZ, scopes TEXT, account_label TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (seller_id,provider)
);
CREATE INDEX IF NOT EXISTS seller_ad_accounts_seller_idx ON seller_ad_accounts(seller_id);

-- Seller product submissions. Listings are seller-owned and require admin review.
CREATE TABLE IF NOT EXISTS seller_products (
  id BIGSERIAL PRIMARY KEY,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  brand TEXT,
  sku TEXT,
  price NUMERIC(12,2) NOT NULL CHECK (price > 0),
  currency CHAR(3) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  seller_country TEXT NOT NULL,
  ships_to TEXT NOT NULL,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seller_products_seller_idx ON seller_products(seller_id,created_at DESC);
CREATE INDEX IF NOT EXISTS seller_products_review_idx ON seller_products(status,created_at DESC);
