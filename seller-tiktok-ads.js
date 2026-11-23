const router = require("express").Router();
const crypto = require("crypto");
const { q } = require("./db");
const { wrap, requireRole } = require("./util");
const { esc, csrfField } = require("./views");

router.use(requireRole("seller"));
const encryptionKey = () => {
  const hex = process.env.TIKTOK_TOKEN_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error("TikTok token encryption key is not configured.");
  return Buffer.from(hex, "hex");
};
const encrypt = (value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: data.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
};
const decrypt = (row) => {
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(row.token_iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.token_auth_tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.token_ciphertext, "base64")), decipher.final()]).toString("utf8");
};
const renderPage = (res, row, notice = "") => {
  const ids = row ? (row.advertiser_ids || []).map((id) => "<li><code>" + esc(id) + "</code></li>").join("") : "";
  res.page("TikTok Ads", `<h1>TikTok Ads</h1><div class="card">
    <div class="ad-connect-head"><div><h2>Your TikTok advertising account</h2><p class="muted">Connect your own TikTok for Business advertiser account. Other sellers cannot see this connection.</p></div>
    <span class="pill ${row ? "pill-approved" : "pill-pending"}">${row ? "Connected" : "Not connected"}</span></div>
    ${notice ? '<div class="flash flash-ok">' + esc(notice) + '</div>' : ""}
    ${row ? '<p><strong>Connected:</strong> ' + esc(new Date(row.connected_at).toLocaleString("en-US")) + '</p><h3>Authorized advertiser accounts</h3><ul>' + (ids || "<li>No advertiser IDs were returned.</li>") + '</ul><p class="muted small">Your access token is encrypted and stored for your seller account only.</p><form method="post" action="/seller/advertising/tiktok/disconnect">' + csrfField(res.locals.csrf) + '<button class="btn btn-ghost" type="submit">Disconnect TikTok Ads</button></form>' : '<ul><li>Authorize your own TikTok Ads account</li><li>Keep your advertising access separate from other sellers</li><li>Connecting does not create campaigns or spend money</li></ul><a class="btn" href="/seller/advertising/tiktok/connect">Connect TikTok Ads</a>'}
  </div><div class="card"><h2>Next step</h2><p class="muted">Campaign reporting and management can be added after the connection is approved and the required TikTok API permissions are granted.</p></div>`);
};
router.get("/", wrap(async (req, res) => {
  const { rows: [row] } = await q("select advertiser_ids, connected_at from seller_tiktok_ads where user_id=$1", [req.session.user.id]);
  renderPage(res, row, req.query.connected === "1" ? "TikTok Ads connected successfully." : "");
}));
router.get("/connect", wrap(async (req, res) => {
  let url;
  try { url = new URL(process.env.TIKTOK_ADVERTISER_AUTH_URL || ""); } catch {
    return res.status(503).page("TikTok setup required", "<div class='card'><h1>TikTok setup required</h1><p>The marketplace administrator must configure the TikTok advertiser authorization URL.</p></div>");
  }
  if (url.protocol !== "https:") return res.status(503).page("TikTok setup required", "<div class='card'><h1>TikTok setup required</h1><p>The TikTok authorization URL must use HTTPS.</p></div>");
  const state = crypto.randomBytes(32).toString("hex");
  req.session.tiktokAdsState = state;
  req.session.tiktokAdsUser = req.session.user.id;
  req.session.save((err) => {
    if (err) return res.status(500).send("Could not start TikTok authorization. Please try again.");
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  });
}));
router.get("/callback", wrap(async (req, res) => {
  const expected = req.session.tiktokAdsState || "";
  const actual = String(req.query.state || "");
  const userId = req.session.user && req.session.user.id;
  delete req.session.tiktokAdsState;
  delete req.session.tiktokAdsUser;
  if (!expected || !actual || !userId || expected.length !== actual.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
    return res.status(400).page("TikTok authorization failed", "<div class='card'><h1>Authorization could not be verified</h1><p>Return to your seller dashboard and try connecting again.</p></div>");
  }
  const authCode = String(req.query.auth_code || "");
  const appId = process.env.TIKTOK_APP_ID || "";
  const secret = process.env.TIKTOK_APP_SECRET || "";
  if (!authCode || authCode.length > 4096 || !appId || !secret) {
    return res.status(503).page("TikTok setup required", "<div class='card'><h1>TikTok setup is incomplete</h1><p>The authorization code or developer app configuration is missing. Please contact marketplace support.</p></div>");
  }
  const response = await fetch("https://business-api.tiktok.com/open_api/v2.0/oauth2/access_token/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, secret, auth_code: authCode, return_advertiser_ids: true })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0 || !payload.data?.access_token) {
    console.error("TikTok token exchange failed", { status: response.status, code: payload.code, request_id: payload.request_id });
    return res.status(502).page("TikTok connection failed", "<div class='card'><h1>TikTok could not complete the connection</h1><p>Please try again or contact marketplace support.</p></div>");
  }
  const token = encrypt(payload.data.access_token);
  const ids = Array.isArray(payload.data.advertiser_ids) ? payload.data.advertiser_ids : [];
  await q(`insert into seller_tiktok_ads (user_id, token_ciphertext, token_iv, token_auth_tag, advertiser_ids, connected_at)
    values ($1,$2,$3,$4,$5::jsonb,now())
    on conflict (user_id) do update set token_ciphertext=excluded.token_ciphertext, token_iv=excluded.token_iv,
    token_auth_tag=excluded.token_auth_tag, advertiser_ids=excluded.advertiser_ids, connected_at=now()`,
    [userId, token.ciphertext, token.iv, token.tag, JSON.stringify(ids)]);
  res.redirect("/seller/advertising/tiktok?connected=1");
}));
router.post("/disconnect", wrap(async (req, res) => {
  const { rows: [row] } = await q("select token_ciphertext, token_iv, token_auth_tag from seller_tiktok_ads where user_id=$1", [req.session.user.id]);
  if (row) {
    try {
      const accessToken = decrypt(row);
      await fetch("https://business-api.tiktok.com/open_api/v2.0/oauth2/revoke_token/", {
        method: "POST", headers: { "Content-Type": "application/json", "Access-Token": accessToken },
        body: JSON.stringify({ app_id: process.env.TIKTOK_APP_ID || "", secret: process.env.TIKTOK_APP_SECRET || "", access_token: accessToken })
      });
    } catch (error) { console.error("TikTok revoke request failed; deleting local token regardless."); }
  }
  await q("delete from seller_tiktok_ads where user_id=$1", [req.session.user.id]);
  res.redirect("/seller/advertising/tiktok");
}));
module.exports = router;
