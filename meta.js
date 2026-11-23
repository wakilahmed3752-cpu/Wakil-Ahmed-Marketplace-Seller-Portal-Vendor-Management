const router = require("express").Router();
const crypto = require("crypto");
const { q } = require("./db");
const { wrap, requireRole } = require("./util");
const { esc, csrfField } = require("./views");

const graphVersion = () => process.env.META_GRAPH_VERSION || "";
const callbackUrl = () => process.env.META_REDIRECT_URI || "https://seller.wakilahmed.com/integrations/meta/callback";
const configured = () => Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_TOKEN_ENCRYPTION_KEY && /^v\\d+\\.\\d+$/.test(graphVersion()));

function encryptionKey() {
  const key = Buffer.from(process.env.META_TOKEN_ENCRYPTION_KEY || "", "base64");
  if (key.length !== 32) throw new Error("META_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}
function decrypt(value) {
  const [iv, tag, data] = String(value).split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
async function graph(path, params = {}) {
  const url = new URL(`https://graph.facebook.com/${graphVersion()}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error?.message || "Meta API request failed");
  return data;
}
function configError(res) {
  return res.status(503).page("Meta Ads connection", `<div class="card"><h1>Meta Ads connection is being configured</h1><p class="muted">The marketplace administrator must add the Meta app credentials and encryption key in the hosting environment before sellers can connect.</p><p><a href="/seller/advertising">Return to Advertising</a></p></div>`);
}

router.get("/seller/advertising", requireRole("seller"), wrap(async (req, res) => {
  const { rows: [connection] } = await q(
    "select ad_account_id, ad_account_name, connected_at, token_expires_at from seller_ad_connections where user_id=$1 and provider='meta'",
    [req.session.user.id]
  );
  const connected = connection ? `<div class="flash flash-ok">Connected to <strong>${esc(connection.ad_account_name)}</strong> (${esc(connection.ad_account_id)}). Your Meta account is linked only to your seller profile.</div>
    <p class="small muted">Connected on ${new Date(connection.connected_at).toLocaleDateString("en-US")}. Meta authorization can expire or be revoked.</p>
    <form method="post" action="/seller/advertising/meta/disconnect">${csrfField(res.locals.csrf)}<button class="btn btn-ghost" type="submit">Disconnect Meta Ads</button></form>`
    : `<p class="muted">No Meta advertising account is connected yet. Connect your own Facebook profile and choose the ad account you manage.</p>
      <a class="btn" href="/seller/advertising/meta/connect">Connect Meta Ads</a>`;
  res.page("Advertising", `<div class="seller-head"><div><h1>Advertising</h1><p class="muted">Connect and manage advertising accounts owned or managed by your business.</p></div></div>
    <div class="card"><div class="section-head"><div><h2>Meta Ads</h2><p class="muted small">Facebook and Instagram advertising</p></div><span class="pill ${connection ? "pill-approved" : "pill-pending"}">${connection ? "Connected" : "Not connected"}</span></div>${connected}</div>
    <div class="card"><h2>Your account, your control</h2><p class="muted">Authorization is completed directly with Meta. We do not ask for your Facebook password. Your connection is stored against your seller account and is not shared with other sellers.</p><p class="small muted">Connecting does not create, publish, or change ads and does not spend money.</p></div>`);
}));

router.get("/seller/advertising/meta/connect", requireRole("seller"), (req, res) => {
  if (!configured()) return configError(res);
  const state = crypto.randomBytes(32).toString("hex");
  req.session.metaOAuthState = state;
  req.session.metaOAuthStarted = Date.now();
  const url = new URL(`https://www.facebook.com/${graphVersion()}/dialog/oauth`);
  url.searchParams.set("client_id", process.env.META_APP_ID);
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "ads_read,ads_management");
  res.redirect(url.toString());
});

router.get("/integrations/meta/callback", wrap(async (req, res) => {
  const expected = req.session.metaOAuthState || "";
  const supplied = String(req.query.state || "");
  const valid = expected.length === supplied.length && expected.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)) &&
    Date.now() - Number(req.session.metaOAuthStarted || 0) < 10 * 60 * 1000;
  delete req.session.metaOAuthState;
  delete req.session.metaOAuthStarted;
  if (!valid) return res.status(400).page("Meta connection failed", "<div class='card'><h1>Authorization expired</h1><p>Please start the Meta connection again from your seller dashboard.</p><a href='/seller/advertising'>Return to Advertising</a></div>");
  if (req.query.error) return res.redirect("/seller/advertising");
  if (!req.session.user || req.session.user.role !== "seller") return res.redirect("/login");
  if (!configured()) return configError(res);
  if (!req.query.code) return res.status(400).page("Meta connection failed", "<div class='card'><h1>Meta did not return an authorization code</h1><a href='/seller/advertising'>Return to Advertising</a></div>");

  const short = await graph("oauth/access_token", {
    client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET,
    redirect_uri: callbackUrl(), code: String(req.query.code)
  });
  const long = await graph("oauth/access_token", {
    grant_type: "fb_exchange_token", client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET, fb_exchange_token: short.access_token
  });
  const accounts = await graph("me/adaccounts", {
    fields: "id,name,account_status,currency,timezone_name", limit: "100",
    access_token: long.access_token
  });
  req.session.metaPending = {
    token: encrypt(long.access_token),
    expiresAt: Date.now() + Number(long.expires_in || 0) * 1000,
    accounts: (accounts.data || []).map((a) => ({
      id: String(a.id), name: String(a.name || a.id),
      status: Number(a.account_status || 0), currency: String(a.currency || "")
    }))
  };
  res.redirect("/seller/advertising/meta/select");
}));

router.get("/seller/advertising/meta/select", requireRole("seller"), (req, res) => {
  const pending = req.session.metaPending;
  if (!pending) return res.redirect("/seller/advertising");
  const options = pending.accounts.filter((a) => a.status === 1)
    .map((a) => `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.id)} ${a.currency ? "· " + esc(a.currency) : ""}</option>`).join("");
  if (!options) return res.page("Choose Meta ad account", "<div class='card'><h1>No eligible ad accounts found</h1><p class='muted'>The Facebook profile did not return an active ad account with the permissions granted. Check your Business portfolio access and try again.</p><a href='/seller/advertising'>Return to Advertising</a></div>");
  res.page("Choose Meta ad account", `<div class="card narrow"><h1>Choose your ad account</h1><p class="muted">Select the Meta ad account you want linked to this seller profile.</p><form method="post" action="/seller/advertising/meta/select">${csrfField(res.locals.csrf)}<label>Ad account<select name="account_id" required>${options}</select></label><button class="btn btn-block" type="submit">Save connection</button></form></div>`);
});

router.post("/seller/advertising/meta/select", requireRole("seller"), wrap(async (req, res) => {
  const pending = req.session.metaPending;
  const account = pending?.accounts.find((a) => a.id === String(req.body.account_id));
  if (!pending || !account || !pending.token) return res.status(400).redirect("/seller/advertising");
  await q(`insert into seller_ad_connections
    (user_id, provider, ad_account_id, ad_account_name, encrypted_access_token, token_expires_at, connected_at)
    values ($1,'meta',$2,$3,$4,$5,now())
    on conflict (user_id, provider) do update set ad_account_id=excluded.ad_account_id,
    ad_account_name=excluded.ad_account_name, encrypted_access_token=excluded.encrypted_access_token,
    token_expires_at=excluded.token_expires_at, connected_at=now()`,
    [req.session.user.id, account.id, account.name, pending.token, new Date(pending.expiresAt)]);
  delete req.session.metaPending;
  req.session.flash = { type: "ok", text: "Your Meta ad account is connected." };
  res.redirect("/seller/advertising");
}));

router.post("/seller/advertising/meta/disconnect", requireRole("seller"), wrap(async (req, res) => {
  await q("delete from seller_ad_connections where user_id=$1 and provider='meta'", [req.session.user.id]);
  req.session.flash = { type: "ok", text: "Meta Ads has been disconnected from your seller account." };
  res.redirect("/seller/advertising");
}));

module.exports = router;
