const router = require("express").Router();
const { q } = require("./db");
const { wrap } = require("./util");
const { esc, money } = require("./views");

// Vendor accounts are a distinct account type, while sharing the approved
// seller authentication and marketplace data model.
router.use(wrap(async (req, res, next) => {
  const sessionUser = req.session.user;
  if (!sessionUser) return res.redirect("/login");
  const { rows } = await q("select role, account_type, status from users where id=$1", [sessionUser.id]);
  const user = rows[0];
  if (!user || user.role !== "seller" || user.status !== "approved") {
    return req.session.destroy(() => res.redirect("/login"));
  }
  if (user.account_type !== "vendor") return res.redirect("/seller");
  next();
}));

router.get("/", wrap(async (req, res) => {
  const id = req.session.user.id;
  const [{ rows: [totals] }, { rows: [products] }, { rows: [profile] }] = await Promise.all([
    q(`select coalesce(sum(gross_cents),0)::bigint sales,
              coalesce(sum(commission_cents),0)::bigint commission,
              coalesce(sum(earning_cents) filter (where status='unpaid'),0)::bigint unpaid,
              coalesce(sum(earning_cents) filter (where status='paid'),0)::bigint paid
       from earnings where user_id=$1`, [id]),
    q(`select count(*)::int total,
              count(*) filter (where status='pending')::int pending,
              count(*) filter (where status='approved')::int approved
       from seller_product_submissions where seller_id=$1`, [id]),
    q("select shop_name, category, commission_rate from users where id=$1", [id])
  ]);
  res.page("Vendor dashboard", `
<h1>Business Vendor Dashboard</h1>
<p class="muted">Manage your business storefront, product catalog, orders and marketplace earnings.</p>
<div class="card list-item-cta"><div><h2>${esc(profile.shop_name || "Your business")}</h2><p class="muted">Vendor account · ${esc(profile.category || "Product category not set")}</p></div><a class="btn" href="/seller/products/new">List an Item</a></div>
<div class="stats">
 <div class="stat"><span>Gross sales</span><strong>${money(totals.sales)}</strong></div>
 <div class="stat"><span>Available earnings</span><strong>${money(totals.unpaid)}</strong></div>
 <div class="stat"><span>Total paid out</span><strong>${money(totals.paid)}</strong></div>
 <div class="stat"><span>Marketplace commission</span><strong>${money(totals.commission)}</strong></div>
</div>
<div class="stats">
 <div class="stat"><span>Total product submissions</span><strong>${products.total}</strong></div>
 <div class="stat"><span>Awaiting review</span><strong>${products.pending}</strong></div>
 <div class="stat"><span>Approved in portal</span><strong>${products.approved}</strong></div>
 <div class="stat"><span>Your commission rate</span><strong>${esc(profile.commission_rate)}%</strong></div>
</div>
<div class="card"><h2>Business operations</h2><div class="vendor-module-grid">
 <a class="vendor-module" href="/seller/products"><strong>Product catalog</strong><span>Manage listings and review status</span></a>
 <a class="vendor-module" href="/seller/orders"><strong>Orders and sales</strong><span>Review recorded marketplace orders</span></a>
 <a class="vendor-module" href="/seller/inventory"><strong>Inventory</strong><span>View current inventory workflow status</span></a>
 <a class="vendor-module" href="/seller/profile"><strong>Payout details</strong><span>Maintain payment destination details</span></a>
 <a class="vendor-module" href="/seller/marketing"><strong>Marketing</strong><span>Prepare product and social campaigns</span></a>
 <a class="vendor-module" href="/seller/advertising"><strong>Advertising</strong><span>Manage your connected advertising workspace</span></a>
 <a class="vendor-module" href="/seller/traffic"><strong>Store analytics</strong><span>Review your account traffic report</span></a>
</div></div>
<div class="card"><h2>Vendor tools and availability</h2>
 <p><span class="pill pill-approved">Available</span> Product submissions, admin review, earnings summary and payout details.</p>
 <p><span class="pill pill-pending">Planned</span> Business verification, store logo and banner, CSV bulk upload, staff access, courier labels, coupons, tax documents, buyer messaging and dispute management.</p>
 <p class="muted small">Approving a listing in the portal does not publish it to Shopify. Shopify publishing and live inventory synchronization are not enabled.</p>
</div>`);
}));

module.exports = router;
