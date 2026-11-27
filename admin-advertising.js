const router = require("express").Router();
const crypto = require("crypto");
const { q } = require("./db");
const { wrap, requireRole } = require("./util");
const { esc, csrfField } = require("./views");

router.use(requireRole("admin"));

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/adwords";

function configured() {
  return Boolean(
    process.env.GOOGLE_ADS_CLIENT_ID &&
    process.env.GOOGLE_ADS_CLIENT_SECRET &&
    process.env.GOOGLE_ADS_ADMIN_REDIRECT_URI &&
    process.env.ADS_TOKEN_ENCRYPTION_KEY
  );
}

function encryptionKey() {
  const value = process.env.ADS_TOKEN_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("ADS_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.");
  }
  return Buffer.from(value, "hex");
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

async function ensureTable() {
  await q(`CREATE TABLE IF NOT EXISTS marketplace_ad_accounts (
    provider TEXT PRIMARY KEY CHECK (provider = 'google'),
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT,
    expires_at TIMESTAMPTZ,
    scopes TEXT NOT NULL,
    connected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

router.get("/", wrap(async (_req, res) => {
  await ensureTable();
  const { rows } = await q(
    "SELECT provider, expires_at, connected_at FROM marketplace_ad_accounts WHERE provider='google'"
  );
  const account = rows[0];
  const ready = configured();
  const status = account ? "Connected" : ready ? "Not connected" : "Setup required";
  const action = account
    ? '<form method="post" action="/admin/advertising/google/disconnect">' +
      csrfField(res.locals.csrf) +
      '<button class="btn btn-ghost btn-sm">Disconnect Google Ads</button></form>'
    : ready
      ? '<form method="post" action="/admin/advertising/google/connect">' +
        csrfField(res.locals.csrf) +
        '<button class="btn btn-sm">Connect marketplace Google Ads</button></form>'
      : '<p class="muted small">Add the required Google OAuth and encryption environment variables in Render.</p>';

  res.page("Marketplace advertising", '<h1>Marketplace advertising</h1>' +
    '<p class="muted">Connect Wakil Ahmed Marketplace’s own Google Ads account. This connection is separate from every seller’s advertising account.</p>' +
    '<div class="card"><div class="seller-head"><div><h2>Google Ads</h2>' +
    '<p class="muted small">Marketplace owner account connection</p></div>' +
    '<span class="pill ' + (account ? "pill-approved" : "pill-pending") + '">' + status + '</span></div>' +
    (account ? '<p class="muted small">Connected ' + new Date(account.connected_at).toLocaleDateString("en-US") + '</p>' : '') +
    '<div class="row">' + action + '</div></div>' +
    '<div class="card"><h2>Account separation and spending controls</h2>' +
    '<p class="muted small">The marketplace connection is stored separately from seller connections. Connecting does not create campaigns, change budgets, or spend money. Campaign management and reporting are not enabled by this connection alone.</p></div>');
}));

router.post("/google/connect", wrap(async (req, res) => {
  if (!configured()) {
    req.session.flash = { type: "error", text: "Marketplace Google Ads connection is not configured. Check the admin redirect URI and encryption key in Render." };
    return res.redirect("/admin/advertising");
  }
  const state = crypto.randomBytes(32).toString("hex");
  req.session.marketplaceGoogleAdsOAuth = { state, createdAt: Date.now() };
  const url = new URL(GOOGLE_AUTHORIZE);
  url.searchParams.set("client_id", process.env.GOOGLE_ADS_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.GOOGLE_ADS_ADMIN_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  res.redirect(url.toString());
}));

router.get("/google/callback", wrap(async (req, res) => {
  const pending = req.session.marketplaceGoogleAdsOAuth;
  delete req.session.marketplaceGoogleAdsOAuth;
  if (!pending || pending.state !== String(req.query.state || "") ||
      Date.now() - pending.createdAt > 10 * 60 * 1000) {
    req.session.flash = { type: "error", text: "Google authorization expired or could not be verified. Please try again." };
    return res.redirect("/admin/advertising");
  }
  if (req.query.error || !req.query.code || !configured()) {
    req.session.flash = { type: "error", text: "Google did not approve the marketplace advertising connection." };
    return res.redirect("/admin/advertising");
  }

  const body = new URLSearchParams({
    code: String(req.query.code),
    client_id: process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    redirect_uri: process.env.GOOGLE_ADS_ADMIN_REDIRECT_URI,
    grant_type: "authorization_code"
  });
  const response = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const tokenData = await response.json();
  if (!response.ok || !tokenData.access_token) {
    console.error("Marketplace Google Ads OAuth token exchange failed:", response.status);
    req.session.flash = { type: "error", text: "Google could not complete the connection. Check the OAuth client and callback settings, then try again." };
    return res.redirect("/admin/advertising");
  }

  await ensureTable();
  await q(`INSERT INTO marketplace_ad_accounts
    (provider, access_token_enc, refresh_token_enc, expires_at, scopes, connected_by)
    VALUES ('google',$1,$2,$3,$4,$5)
    ON CONFLICT (provider) DO UPDATE SET
      access_token_enc=EXCLUDED.access_token_enc,
      refresh_token_enc=COALESCE(EXCLUDED.refresh_token_enc, marketplace_ad_accounts.refresh_token_enc),
      expires_at=EXCLUDED.expires_at,
      scopes=EXCLUDED.scopes,
      connected_by=EXCLUDED.connected_by,
      connected_at=now()`,
    [encrypt(tokenData.access_token), tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
      tokenData.expires_in ? new Date(Date.now() + Number(tokenData.expires_in) * 1000) : null,
      SCOPE, req.session.user.id]);

  req.session.flash = { type: "ok", text: "Marketplace Google Ads account connected. No campaigns or advertising spend were changed." };
  res.redirect("/admin/advertising");
}));

router.post("/google/disconnect", wrap(async (_req, res) => {
  await ensureTable();
  await q("DELETE FROM marketplace_ad_accounts WHERE provider='google'");
  res.redirect("/admin/advertising");
}));

module.exports = router;
