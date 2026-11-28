-- Runs safely on every start (all statements are IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'seller' CHECK (role IN ('seller','admin')),
  account_type    TEXT NOT NULL DEFAULT 'seller' CHECK (account_type IN ('seller','vendor')),
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
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'seller';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_type_check;
ALTER TABLE users ADD CONSTRAINT users_account_type_check CHECK (account_type IN ('seller','vendor'));

CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_shop_uq  ON users (lower(shop_name)) WHERE shop_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS payouts (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  currency     TEXT,
  method       TEXT,
  reference    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS earnings (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  order_id         TEXT NOT NULL,
  order_name       TEXT,
  order_date       TIMESTAMPTZ,
  currency         TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('sale','refund')),
  source_id        TEXT NOT NULL,
  gross_cents      INTEGER NOT NULL,
  rate             NUMERIC(5,2) NOT NULL,
  commission_cents INTEGER NOT NULL,
  earning_cents    INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid')),
  payout_id        INTEGER REFERENCES payouts(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, user_id, kind)
);
CREATE INDEX IF NOT EXISTS earnings_user_idx ON earnings (user_id, status);

CREATE TABLE IF NOT EXISTS processed_webhooks (
  id         TEXT PRIMARY KEY,
  topic      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR NOT NULL PRIMARY KEY,
  "sess"   JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- Employee accounts are separate from administrators and sellers.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('seller','admin','employee'));


-- Each seller has one isolated TikTok Ads authorization. Access tokens are
-- encrypted by the application before they are stored in this table.
CREATE TABLE IF NOT EXISTS seller_tiktok_ads (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_ciphertext TEXT NOT NULL,
  token_iv         TEXT NOT NULL,
  token_auth_tag   TEXT NOT NULL,
  advertiser_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  connected_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Each seller owns an isolated set of advertising OAuth connections.
CREATE TABLE IF NOT EXISTS seller_ad_accounts (
  id SERIAL PRIMARY KEY,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','meta','tiktok')),
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at TIMESTAMPTZ,
  scopes TEXT,
  account_label TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (seller_id, provider)
);
CREATE INDEX IF NOT EXISTS seller_ad_accounts_seller_idx ON seller_ad_accounts(seller_id);

-- Privacy-conscious portal analytics. Raw IP addresses are never stored.
CREATE TABLE IF NOT EXISTS portal_visits (
  id BIGSERIAL PRIMARY KEY,
  visitor_hash TEXT NOT NULL,
  visit_date DATE NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  country TEXT NOT NULL DEFAULT 'Unknown',
  country_code TEXT,
  last_path TEXT,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (visitor_hash, visit_date)
);
CREATE INDEX IF NOT EXISTS portal_visits_seen_idx ON portal_visits(last_seen);
CREATE INDEX IF NOT EXISTS portal_visits_user_date_idx ON portal_visits(user_id, visit_date);
CREATE INDEX IF NOT EXISTS portal_visits_country_idx ON portal_visits(country);


-- Seller-submitted catalog listings. Approval is internal until Shopify Admin API publishing is configured.
CREATE TABLE IF NOT EXISTS seller_product_submissions (
  id BIGSERIAL PRIMARY KEY,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 10 AND 10000),
  category TEXT NOT NULL CHECK (char_length(category) BETWEEN 2 AND 80),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  sku TEXT,
  inventory_quantity INTEGER NOT NULL DEFAULT 0 CHECK (inventory_quantity >= 0),
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seller_product_submissions_seller_idx
  ON seller_product_submissions(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS seller_product_submissions_status_idx
  ON seller_product_submissions(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS seller_product_submissions_sku_uq
  ON seller_product_submissions(seller_id, lower(sku))
  WHERE sku IS NOT NULL AND sku <> '';


-- Shopify publishing state for approved seller and vendor listings.
ALTER TABLE seller_product_submissions ADD COLUMN IF NOT EXISTS shopify_product_id TEXT;
ALTER TABLE seller_product_submissions ADD COLUMN IF NOT EXISTS shopify_product_url TEXT;
ALTER TABLE seller_product_submissions ADD COLUMN IF NOT EXISTS shopify_published_at TIMESTAMPTZ;
ALTER TABLE seller_product_submissions ADD COLUMN IF NOT EXISTS shopify_sync_error TEXT;
