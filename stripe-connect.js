const router = require("express").Router();
const crypto = require("crypto");
const { q } = require("./db");
const { wrap, requireRole } = require("./util");
const { esc, csrfField } = require("./views");

router.use(requireRole("seller"));

const stripeRequest = async (path, method = "GET", params = null, idempotencyKey = null) => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !key.startsWith("sk_")) {
    const err = new Error("Stripe is not configured yet. The marketplace administrator must add STRIPE_SECRET_KEY in the private Render environment settings.");
    err.status = 503;
    throw err;
  }
  const headers = { Authorization: "Bearer " + key };
  const options = { method, headers };
  if (params) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = params.toString();
  }
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch("https://api.stripe.com/v1" + path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error?.message || "Stripe could not complete the request.");
    err.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw err;
  }
  return data;
};

const page = (res, account, notice = "") => {
  const state = account
    ? '<div class="flash flash-ok">Stripe account connected: ' + esc(account.id) + '</div><p><strong>Verification:</strong> ' + (account.details_submitted ? "Submitted" : "Not completed") + '</p><p><strong>Payout eligibility:</strong> ' + (account.payouts_enabled ? "Enabled" : "Waiting for Stripe verification") + '</p><p class="muted small">Stripe may request identity, business and bank information directly from you. The marketplace does not receive or store your bank account number.</p><form method="post" action="/seller/stripe/onboarding">' + csrfField(res.locals.csrf) + '<button class="btn">Continue or update Stripe verification</button></form>'
    : '<p class="muted">Connect a supported bank payout account securely through Stripe. Your bank details are entered on Stripe, not in this marketplace portal.</p><form method="post" action="/seller/stripe/onboarding">' + csrfField(res.locals.csrf) + '<label>Country where your payout account is registered *<input name="country" required minlength="2" maxlength="2" pattern="[A-Za-z]{2}" placeholder="US" autocomplete="country" value="US"></label><p class="muted small">Enter the two-letter country code, such as US, GB, CA, PK or IN. Stripe will confirm whether that country can be onboarded for this marketplace.</p><button class="btn">Connect securely with Stripe</button></form>';
  res.page("Stripe seller payouts", '<div class="card narrow"><h1>Connect Stripe payouts</h1>' + (notice ? '<div class="flash flash-ok">' + esc(notice) + '</div>' : '') + state + '<p class="muted small">Seller payouts are not available until Stripe approves your account and the marketplace has a funded, compliant payout process. Connecting Stripe does not guarantee immediate payments.</p></div>');
};

router.get("/", wrap(async (req, res) => {
  const { rows: [u] } = await q("select stripe_account_id,stripe_account_details_submitted,stripe_account_payouts_enabled from users where id=$1", [req.session.user.id]);
  let account = null;
  if (u.stripe_account_id) {
    account = await stripeRequest("/accounts/" + encodeURIComponent(u.stripe_account_id));
    await q("update users set stripe_account_details_submitted=$1,stripe_account_payouts_enabled=$2 where id=$3",
      [!!account.details_submitted, !!account.payouts_enabled, req.session.user.id]);
  }
  const notice = req.query.connect === "return" ? "Stripe returned you to the portal. Check the verification status below." :
    req.query.connect === "refresh" ? "Please continue the Stripe verification process below." : "";
  page(res, account, notice);
}));

router.post("/onboarding", wrap(async (req, res) => {
  const sellerId = req.session.user.id;
  const country = String(req.body.country || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    req.session.flash = { type: "error", text: "Enter a valid two-letter country code." };
    return res.redirect("/seller/stripe");
  }
  const base = (process.env.APP_BASE_URL || "https://seller.wakilahmed.com").replace(/\/$/, "");
  const { rows: [seller] } = await q("select id,email,name,stripe_account_id from users where id=$1 and role='seller'", [sellerId]);
  if (!seller) return res.status(403).send("Seller account required.");
  let accountId = seller.stripe_account_id;
  if (!accountId) {
    const params = new URLSearchParams();
    params.set("type", "express");
    params.set("country", country);
    params.set("email", seller.email);
    params.set("capabilities[transfers][requested]", "true");
    params.set("business_profile[name]", "Wakil Ahmed Marketplace seller " + seller.name);
    const account = await stripeRequest("/accounts", "POST", params, "seller-connect-account-" + sellerId);
    accountId = account.id;
    await q("update users set stripe_account_id=$1,stripe_account_country=$2 where id=$3", [accountId, country, sellerId]);
  }
  const linkParams = new URLSearchParams();
  linkParams.set("account", accountId);
  linkParams.set("type", "account_onboarding");
  linkParams.set("return_url", base + "/seller/stripe?connect=return");
  linkParams.set("refresh_url", base + "/seller/stripe?connect=refresh");
  const link = await stripeRequest("/account_links", "POST", linkParams);
  res.redirect(303, link.url);
}));

module.exports = router;
