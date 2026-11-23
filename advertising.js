const router = require("express").Router();
const crypto = require("crypto");
const { q } = require("./db");
const { wrap, requireRole } = require("./util");
const { esc, csrfField } = require("./views");

router.use(requireRole("seller"));

const providers = {
  google: {
    label: "Google Ads",
    clientId: () => process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_ADS_CLIENT_SECRET,
    redirect: "GOOGLE_ADS_REDIRECT_URI",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/adwords",
  },
  meta: {
    label: "Meta Ads",
    clientId: () => process.env.META_ADS_APP_ID,
    clientSecret: () => process.env.META_ADS_APP_SECRET,
    redirect: "META_ADS_REDIRECT_URI",
    authorize: "https://www.facebook.com/v21.0/dialog/oauth",
    token: "https://graph.facebook.com/v21.0/oauth/access_token",
    scope: "ads_read,read_insights",
  },
  tiktok: {
    label: "TikTok Ads",
    clientId: () => process.env.TIKTOK_ADS_APP_ID,
    clientSecret: () => process.env.TIKTOK_ADS_APP_SECRET,
    redirect: "TIKTOK_ADS_REDIRECT_URI",
    authorize: "https://business-api.tiktok.com/portal/auth",
    token: "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/",
    scope: "advertiser.info,report",
  },
};

function configured(p) {
  return Boolean(p.clientId() && p.clientSecret() && process.env[p.redirect] && process.env.ADS_TOKEN_ENCRYPTION_KEY);
}
function key() {
  const value = process.env.ADS_TOKEN_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("ADS_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.");
  return Buffer.from(value, "hex");
}
function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString("base64url")).join(".");
}
function open(value) {
  const [iv, tag, encrypted] = String(value).split(".").map((s) => Buffer.from(s, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
function safeState() { return crypto.randomBytes(32).toString("hex"); }

router.get("/", wrap(async (req, res) => {
  const { rows } = await q("select provider, account_label, connected_at from seller_ad_accounts where seller_id=$1 order by provider", [req.session.user.id]);
  const connected = Object.fromEntries(rows.map((r) => [r.provider, r]));
  const csrf = res.locals.csrf;
  const cards = Object.entries(providers).map(([id, p]) => {
    const row = connected[id];
    const ready = configured(p);
    const status = row ? "Connected" : ready ? "Not connected" : "Setup required";
    const action = row
      ? '<form method="post" action="/seller/advertising/' + id + '/disconnect">' + csrfField(csrf) + '<button class="btn btn-ghost btn-sm">Disconnect</button></form>'
      : ready
        ? '<form method="post" action="/seller/advertising/' + id + '/connect">' + csrfField(csrf) + '<button class="btn btn-sm">Connect ' + esc(p.label) + '</button></form>'
        : '<span class="muted small">Marketplace setup pending</span>';
    return '<div class="card"><div class="seller-head"><div><h2>' + esc(p.label) + '</h2><p class="muted small">' +
      (id === "google" ? "Google Search and Shopping advertising" : id === "meta" ? "Facebook and Instagram advertising" : "TikTok advertising") +
      '</p></div><span class="pill ' + (row ? "pill-approved" : "pill-pending") + '">' + status + '</span></div>' +
      (row ? '<p class="muted small">Connected ' + new Date(row.connected_at).toLocaleDateString("en-US") + (row.account_label ? " · " + esc(row.account_label) : "") + '</p>' : "") +
      '<div class="row">' + action + '</div></div>';
  }).join("");
  res.page("Advertising accounts", '<h1>Advertising accounts</h1><p class="muted">Connect your own advertising accounts. Your connections and credentials are private to your seller account.</p>' + cards +
    '<div class="card"><h2>Account safety</h2><p class="muted small">Connecting an account does not create campaigns, change budgets, or spend money. Disconnect at any time. The marketplace stores OAuth tokens encrypted and never asks for your advertising password.</p></div>');
}));

router.post("/:provider/connect", wrap(async (req, res) => {
  const id = req.params.provider;
  const p = providers[id];
  if (!p) return res.status(404).send("Unknown advertising provider.");
  if (!configured(p)) {
    req.session.flash = { type: "error", text: p.label + " connection is not configured by the marketplace yet." };
    return res.redirect("/seller/advertising");
  }
  const state = safeState();
  req.session.adOAuth = { provider: id, state, createdAt: Date.now() };
  const redirect = process.env[p.redirect];
  let url;
  if (id === "tiktok") {
    url = new URL(p.authorize);
    url.searchParams.set("app_id", p.clientId());
    url.searchParams.set("state", state);
  } else {
    url = new URL(p.authorize);
    url.searchParams.set("client_id", p.clientId());
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", p.scope);
    url.searchParams.set("state", state);
    if (id === "google") {
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("include_granted_scopes", "true");
    }
  }
  res.redirect(url.toString());
}));

router.get("/:provider/callback", wrap(async (req, res) => {
  const id = req.params.provider;
  const p = providers[id];
  const pending = req.session.adOAuth;
  delete req.session.adOAuth;
  if (!p || !pending || pending.provider !== id || pending.state !== String(req.query.state || "") || Date.now() - pending.createdAt > 10 * 60 * 1000) {
    req.session.flash = { type: "error", text: "Advertising authorization expired or could not be verified. Please try again." };
    return res.redirect("/seller/advertising");
  }
  if (req.query.error || !req.query.code) {
    req.session.flash = { type: "error", text: "The advertising provider did not approve the connection." };
    return res.redirect("/seller/advertising");
  }
  if (!configured(p)) return res.redirect("/seller/advertising");
  const redirect = process.env[p.redirect];
  let tokenData;
  if (id === "tiktok") {
    const response = await fetch(p.token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: p.clientId(), secret: p.clientSecret(), auth_code: String(req.query.code) }),
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0 || !data.data || !data.data.access_token) throw new Error("TikTok token exchange failed.");
    tokenData = { access_token: data.data.access_token, refresh_token: data.data.refresh_token || null, expires_in: data.data.access_token_expire_in || null };
  } else {
    const body = new URLSearchParams({ code: String(req.query.code), client_id: p.clientId(), client_secret: p.clientSecret(), redirect_uri: redirect, grant_type: "authorization_code" });
    const response = await fetch(p.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    tokenData = await response.json();
    if (!response.ok || !tokenData.access_token) throw new Error(id + " token exchange failed.");
  }
  await q(
    `insert into seller_ad_accounts (seller_id, provider, access_token_enc, refresh_token_enc, expires_at, scopes)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (seller_id, provider) do update set access_token_enc=excluded.access_token_enc,
       refresh_token_enc=excluded.refresh_token_enc, expires_at=excluded.expires_at, scopes=excluded.scopes,
       account_label=null, connected_at=now()`,
    [req.session.user.id, id, seal(tokenData.access_token), tokenData.refresh_token ? seal(tokenData.refresh_token) : null,
      tokenData.expires_in ? new Date(Date.now() + Number(tokenData.expires_in) * 1000) : null, p.scope]
  );
  req.session.flash = { type: "ok", text: p.label + " connected to your seller account. No campaigns were changed." };
  res.redirect("/seller/advertising");
}));

router.post("/:provider/disconnect", wrap(async (req, res) => {
  const id = req.params.provider;
  if (!providers[id]) return res.status(404).send("Unknown advertising provider.");
  await q("delete from seller_ad_accounts where seller_id=$1 and provider=$2", [req.session.user.id, id]);
  req.session.flash = { type: "ok", text: providers[id].label + " disconnected from your seller account." };
  res.redirect("/seller/advertising");
}));

module.exports = router;
