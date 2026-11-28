const router = require("express").Router();
const { q } = require("./db");
const { wrap, requireRole } = require("./util");
const { esc, money, date, csrfField } = require("./views");

router.use(requireRole("seller"));

const rowsTable = (rows) =>
  rows.length
    ? `<div class="scroll"><table>
  <tr><th>Date</th><th>Order</th><th>Type</th><th class="r">Sales</th><th class="r">Commission</th><th class="r">Your earnings</th><th>Status</th></tr>
  ${rows
    .map(
      (r) => `<tr><td>${date(r.order_date)}</td><td>${esc(r.order_name)}</td><td>${esc(r.kind)}</td>
      <td class="r">${money(r.gross_cents, r.currency)}</td><td class="r">${money(r.commission_cents, r.currency)}</td>
      <td class="r"><strong>${money(r.earning_cents, r.currency)}</strong></td>
      <td><span class="pill pill-${esc(r.status)}">${esc(r.status)}</span></td></tr>`
    )
    .join("")}
</table></div>`
    : `<p class="muted">No orders yet. Sales of your products will appear here.</p>`;

router.get(
  "/",
  wrap(async (req, res) => {
    const id = req.session.user.id;
    const { rows: [t] } = await q(
      `select coalesce(sum(gross_cents),0)::bigint sales, coalesce(sum(commission_cents),0)::bigint commission,
              coalesce(sum(earning_cents) filter (where status='unpaid'),0)::bigint unpaid,
              coalesce(sum(earning_cents) filter (where status='paid'),0)::bigint paid,
              max(currency) cur
       from earnings where user_id = $1`, [id]);
    const { rows: monthly } = await q(
      `select to_char(date_trunc('month', order_date), 'Mon') label, coalesce(sum(gross_cents),0)::bigint sales
       from earnings where user_id=$1 and order_date >= date_trunc('month', now()) - interval '5 months'
       group by date_trunc('month', order_date) order by date_trunc('month', order_date)`, [id]);
    const maxSales = Math.max(1, ...monthly.map((m) => Number(m.sales)));
    const chart = monthly.length ? monthly.map((m) =>
      `<div class="chart-col"><div class="chart-value">${money(m.sales, t.cur || "")}</div><div class="chart-bar-wrap"><div class="chart-bar" style="height:${Math.max(4, Math.round(Number(m.sales) / maxSales * 100))}%"></div></div><span>${esc(m.label)}</span></div>`
    ).join("") : '<p class="muted">Your sales activity will appear here when orders arrive.</p>';
    const { rows: recent } = await q("select * from earnings where user_id=$1 order by order_date desc nulls last, id desc limit 10", [id]);
    const { rows: pays } = await q("select * from payouts where user_id=$1 order by id desc limit 10", [id]);
    const { rows: [me] } = await q("select shop_name, commission_rate from users where id=$1", [id]);
    const cur = t.cur || "";
    res.page("Dashboard", `
<h1>${esc(me.shop_name)}</h1>
<div class="card list-item-cta"><div><h2>Have a product to sell?</h2><p class="muted">Submit a product for marketplace review.</p></div><a class="btn" href="/seller/products/new">List an Item</a></div>
<div class="stats">
  <div class="stat"><span>Balance owed to you</span><strong>${money(t.unpaid, cur)}</strong></div>
  <div class="stat"><span>Total paid out</span><strong>${money(t.paid, cur)}</strong></div>
  <div class="stat"><span>Net sales</span><strong>${money(t.sales, cur)}</strong></div>
  <div class="stat"><span>Commission (${esc(me.commission_rate)}%)</span><strong>${money(t.commission, cur)}</strong></div>
</div>
<div class="card sales-card"><div class="section-head"><div><h2>Sales performance</h2><p class="muted small">Gross sales · Last 6 months</p></div><span class="chart-key"><i></i> Sales</span></div><div class="sales-chart">${chart}</div></div>
<div class="card"><h2>Recent orders</h2>${rowsTable(recent)}<p><a href="/seller/orders">View all orders</a></p></div>
<div class="card"><h2>Payment history</h2>${
      pays.length
        ? `<div class="scroll"><table><tr><th>Date</th><th>Method</th><th>Reference</th><th class="r">Amount</th></tr>${pays
            .map((p) => `<tr><td>${date(p.created_at)}</td><td>${esc(p.method)}</td><td>${esc(p.reference)}</td><td class="r">${money(p.amount_cents, p.currency)}</td></tr>`)
            .join("")}</table></div>`
        : `<p class="muted">No payouts yet.</p>`
    }</div>`);
  })
);

router.get(
  "/orders",
  wrap(async (req, res) => {
    const { rows } = await q("select * from earnings where user_id=$1 order by order_date desc nulls last, id desc limit 300", [req.session.user.id]);
    res.page("Orders", `<h1>Orders</h1><div class="card">${rowsTable(rows)}</div>`);
  })
);

router.get(
  "/profile",
  wrap(async (req, res) => {
    const { rows: [u] } = await q("select * from users where id=$1", [req.session.user.id]);
    const sel = (v) => (u.payout_method === v ? "selected" : "");
    res.page("Payout details", `
<div class="card narrow"><h1>Payout details</h1>
<p class="muted">We pay your balance to these details. Only you and the marketplace admin can see them.</p>
<form method="post" action="/seller/profile">${csrfField(res.locals.csrf)}
  <label>Phone / WhatsApp<input name="phone" maxlength="40" value="${esc(u.phone)}"></label>
  <label>Payout method<select name="payout_method">
    <option value="">Choose one</option>
    <option ${sel("Bank transfer")}>Bank transfer</option><option ${sel("PayPal")}>PayPal</option><option ${sel("Other")}>Other</option></select></label>
  <label>Account details<textarea name="payout_details" rows="4" maxlength="500" placeholder="Bank name, account name and number, or PayPal email">${esc(u.payout_details)}</textarea></label>
  <button class="btn">Save</button>
</form></div>`);
  })
);

router.post(
  "/profile",
  wrap(async (req, res) => {
    const method = ["Bank transfer", "PayPal", "Other"].includes(req.body.payout_method) ? req.body.payout_method : null;
    await q("update users set phone=$1, payout_method=$2, payout_details=$3 where id=$4", [
      (req.body.phone || "").trim().slice(0, 40),
      method,
      (req.body.payout_details || "").trim().slice(0, 500),
      req.session.user.id,
    ]);
    req.session.flash = { type: "ok", text: "Payout details saved." };
    res.redirect("/seller/profile");
  })
);


// Seller product submissions are isolated by seller_id and require admin review.
router.get("/products", wrap(async (req, res) => {
  const { rows } = await q("select id, title, category, price_cents, status, created_at, admin_note from seller_product_submissions where seller_id=$1 order by created_at desc", [req.session.user.id]);
  const list = rows.length
    ? '<div class="scroll"><table><tr><th>Product</th><th>Category</th><th class="r">Price</th><th>Status</th><th>Submitted</th><th>Admin note</th></tr>' +
      rows.map(p => '<tr><td>' + esc(p.title) + '</td><td>' + esc(p.category) + '</td><td class="r">$' + money(p.price_cents) + '</td><td><span class="pill pill-' + esc(p.status) + '">' + esc(p.status) + '</span></td><td>' + date(p.created_at) + '</td><td>' + esc(p.admin_note || '—') + '</td></tr>').join('') +
      '</table></div>'
    : '<p class="muted">You have not submitted any products yet. Select “List an Item” to get started.</p>';
  res.page("Products", '<div class="section-head"><div><h1>My product listings</h1><p class="muted">Submit products for marketplace admin review.</p></div><a class="btn" href="/seller/products/new">List an Item</a></div><div class="card">' + list + '</div><p class="muted small">After admin approval, your listing is sent to Shopify for publication. You can check the publishing status here.</p>');
}));

router.get("/products/new", (_req, res) => res.page("List a Product",
  '<h1>List a Product</h1><p class="muted">Complete the product details for marketplace review. Your listing is not published until approved.</p>' +
  '<form method="post" action="/seller/products" class="product-listing-form">' + csrfField(res.locals.csrf) +
  '<div class="card"><h2>Product information</h2>' +
  '<label>Product name<input name="title" required minlength="3" maxlength="160"></label>' +
  '<label>Product description<textarea name="description" required minlength="10" maxlength="10000" rows="7"></textarea></label>' +
  '<div class="form-grid"><label>Brand<input name="brand" maxlength="120"></label><label>Product type<input name="product_type" maxlength="120"></label>' +
  '<label>Category<input name="category" required maxlength="80"></label><label>Subcategory<input name="subcategory" maxlength="80"></label></div>' +
  '<label>Tags <small>Separate with commas</small><input name="tags" maxlength="1000"></label></div>' +
  '<div class="card"><h2>Product images</h2><p class="muted small">Enter public HTTPS image links, one per line. The first image is the featured image.</p>' +
  '<label>Image URLs<textarea name="image_urls" rows="4" maxlength="6000" placeholder="https://example.com/front.jpg"></textarea></label>' +
  '<label>Image alt text<input name="image_alt" maxlength="250"></label></div>' +
  '<div class="card"><h2>Pricing and inventory</h2><div class="form-grid">' +
  '<label>Price (USD)<input name="price" type="number" required min="0.01" max="1000000" step="0.01"></label>' +
  '<label>Compare-at price (USD)<input name="compare_at_price" type="number" min="0" max="1000000" step="0.01"></label>' +
  '<label>Cost per item (USD)<input name="cost_per_item" type="number" min="0" max="1000000" step="0.01"></label>' +
  '<label>SKU<input name="sku" maxlength="80"></label><label>Barcode / GTIN<input name="barcode" maxlength="80"></label>' +
  '<label>Available quantity<input name="inventory_quantity" type="number" required min="0" max="1000000" step="1" value="0"></label></div></div>' +
  '<div class="card"><h2>Variants</h2><p class="muted small">Options JSON example: [{"name":"Size","values":["S","M","L"]}]. Variant rows JSON example: [{"optionValues":{"Size":"M"},"price":"19.99","sku":"ITEM-M","inventoryQuantity":5}].</p>' +
  '<label>Product options JSON<textarea name="variant_options" rows="3" maxlength="4000" placeholder=\'[{"name":"Size","values":["S","M","L"]}]\'></textarea></label>' +
  '<label>Variant details JSON<textarea name="variant_rows" rows="4" maxlength="8000" placeholder=\'[{"optionValues":{"Size":"M"},"price":"19.99","sku":"ITEM-M","inventoryQuantity":5}]\'>[]</textarea></label></div>' +
  '<div class="card"><h2>Shipping and tax</h2><div class="form-grid">' +
  '<label>Weight<input name="weight_value" type="number" min="0" max="100000" step="0.001"></label>' +
  '<label>Weight unit<select name="weight_unit"><option value="lb">Pounds (lb)</option><option value="oz">Ounces (oz)</option><option value="kg">Kilograms (kg)</option><option value="g">Grams (g)</option></select></label>' +
  '<label>Country of origin<input name="country_of_origin" maxlength="2" placeholder="US"></label><label>HS tariff code<input name="hs_code" maxlength="20"></label></div>' +
  '<label class="check"><input type="checkbox" name="requires_shipping" value="true" checked> Physical product requiring shipping</label>' +
  '<label class="check"><input type="checkbox" name="taxable" value="true" checked> Charge tax on this product</label></div>' +
  '<div class="card"><h2>Search engine listing</h2><label>SEO page title<input name="seo_title" maxlength="70"></label>' +
  '<label>Meta description<textarea name="seo_description" rows="3" maxlength="320"></textarea></label>' +
  '<label>URL handle<input name="handle" maxlength="120"></label></div>' +
  '<div class="card"><button class="btn btn-block" type="submit">Submit Product for Approval</button></div></form>'
));

router.post("/products", wrap(async (req, res) => {
  const title = (req.body.title || "").trim().slice(0, 160);
  const category = (req.body.category || "").trim().slice(0, 80);
  const description = (req.body.description || "").trim().slice(0, 10000);
  const price = Number(req.body.price);
  const quantity = Number(req.body.inventory_quantity);
  const sku = (req.body.sku || "").trim().slice(0, 80) || null;
  const images = String(req.body.image_urls || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 12);
  const tags = String(req.body.tags || "").split(",").map(x => x.trim()).filter(Boolean).slice(0, 30);
  const cents = v => v === undefined || v === "" ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 100) : NaN);
  const compareAt = cents(req.body.compare_at_price), cost = cents(req.body.cost_per_item);
  const weight = req.body.weight_value === "" || req.body.weight_value === undefined ? null : Number(req.body.weight_value);
  let options = [], variantRows = [];
  try { options = req.body.variant_options ? JSON.parse(req.body.variant_options) : []; variantRows = req.body.variant_rows ? JSON.parse(req.body.variant_rows) : []; }
  catch (_) { req.session.flash = { type: "error", text: "Variant fields must contain valid JSON." }; return res.redirect("/seller/products/new"); }
  const validImages = images.every(url => { try { return new URL(url).protocol === "https:"; } catch (_) { return false; } });
  if (title.length < 3 || category.length < 2 || description.length < 10 || !Number.isFinite(price) || price <= 0 || price > 1000000 ||
      !Number.isInteger(quantity) || quantity < 0 || quantity > 1000000 || (compareAt !== null && !Number.isFinite(compareAt)) ||
      (cost !== null && !Number.isFinite(cost)) || (weight !== null && (!Number.isFinite(weight) || weight < 0)) || !validImages ||
      !Array.isArray(options) || !Array.isArray(variantRows) || options.length > 3 || variantRows.length > 100) {
    req.session.flash = { type: "error", text: "Please check required fields, prices, quantities, HTTPS image links and variant JSON." };
    return res.redirect("/seller/products/new");
  }
  const unit = ["lb","oz","kg","g"].includes(req.body.weight_unit) ? req.body.weight_unit : "lb";
  const handle = (req.body.handle || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0,120) || null;
  try {
    await q(`insert into seller_product_submissions
      (seller_id,title,description,category,price_cents,sku,inventory_quantity,image_url,brand,product_type,subcategory,tags,image_urls,compare_at_price_cents,cost_per_item_cents,barcode,weight_value,weight_unit,requires_shipping,taxable,country_of_origin,hs_code,seo_title,seo_description,handle,variant_options,variant_rows)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27::jsonb)`,
      [req.session.user.id,title,description,category,Math.round(price*100),sku,quantity,images[0]||null,
       (req.body.brand||"").trim().slice(0,120)||null,(req.body.product_type||"").trim().slice(0,120)||null,(req.body.subcategory||"").trim().slice(0,80)||null,tags,
       JSON.stringify(images.map(url=>({url,altText:(req.body.image_alt||"").trim().slice(0,250)||title}))),compareAt,cost,
       (req.body.barcode||"").trim().slice(0,80)||null,weight,unit,req.body.requires_shipping==="true",req.body.taxable==="true",
       (req.body.country_of_origin||"").trim().toUpperCase().slice(0,2)||null,(req.body.hs_code||"").trim().slice(0,20)||null,
       (req.body.seo_title||"").trim().slice(0,70)||null,(req.body.seo_description||"").trim().slice(0,320)||null,handle,JSON.stringify(options),JSON.stringify(variantRows)]);
  } catch (e) {
    if (e.code === "23505") { req.session.flash = { type: "error", text: "That SKU is already used by one of your submitted products. Please enter a different SKU." }; return res.redirect("/seller/products/new"); }
    throw e;
  }
  req.session.flash = { type: "ok", text: "Your product was submitted successfully and is waiting for admin review." };
  res.redirect("/seller/products");
}));
router.get("/inventory", (_req, res) => res.page("Inventory", '<h1>Inventory</h1><div class="card"><h2>Inventory sync not enabled</h2><p class="muted">Live stock quantities are not currently synchronized with Shopify. This page is a placeholder until inventory permissions and stock update workflows are implemented.</p><p class="small muted">No inventory quantities have been changed.</p></div>'));


// Seller marketing workspace: planning tools only. Publishing and email delivery
// remain disabled until approved platform connections and delivery workflows exist.
router.get("/marketing", (_req, res) => {
  const platforms = [
    ["TikTok", "Short-form video ideas, hooks, captions and posting calendars"],
    ["Facebook", "Page content, product announcements and community updates"],
    ["Instagram", "Reels, captions, Stories and product-focused content"],
    ["Pinterest", "Search-friendly Pins, board ideas and product descriptions"]
  ];
  const platformCards = platforms.map(([name, detail]) =>
    '<div class="card"><div class="seller-head"><div><h2>' + name + '</h2><p class="muted small">' + detail + '</p></div><span class="pill pill-pending">Planning only</span></div></div>'
  ).join("");
  res.page("Marketing", `
<h1>Marketing workspace</h1>
<p class="muted">Plan product marketing and review channel performance from one place. These tools help prepare content; they do not publish or send messages.</p>
<div class="card">
  <h2>Product titles, descriptions and search optimization</h2>
  <p class="muted">Prepare clearer product titles, product descriptions, keyword ideas, search snippets and image alt text before updating a product listing.</p>
  <span class="pill pill-pending">Planning tools</span>
</div>
<h2>Social content planning</h2>
<div class="stats marketing-platforms">${platformCards}</div>
<div class="card">
  <h2>Email campaign planning and customer announcements</h2>
  <p class="muted">Draft campaign themes, customer announcements, subject lines and message schedules for review.</p>
  <span class="pill pill-pending">Drafts only</span>
</div>
<div class="card">
  <h2>Campaign performance review</h2>
  <p class="muted">Review reach, engagement, clicks and conversions when supported channel data is connected and available.</p>
  <span class="pill pill-pending">Channel data not connected</span>
</div>
<div class="card">
  <h2>Publishing and email permissions</h2>
  <p class="muted">This workspace does not publish social posts or send emails. Those actions remain disabled until an approved platform connection is configured and the required permissions are granted.</p>
  <p class="small muted">No social posts have been published and no customer emails have been sent from this workspace.</p>
</div>`);
});


router.get("/traffic", wrap(async (req, res) => {
  const id = req.session.user.id;
  const { rows: [totals] } = await q(`
    select count(*) filter (where visit_date=current_date)::int today,
           count(*) filter (where visit_date >= current_date-6)::int last7,
           count(*) filter (where visit_date >= current_date-29)::int last30,
           count(*)::int all_time,
           count(distinct visitor_hash) filter (where last_seen >= now()-interval '5 minutes')::int live
    from portal_visits where user_id=$1`, [id]);
  const { rows: countries } = await q(`
    select country, count(*)::int visits from portal_visits
    where user_id=$1 and visit_date >= current_date-29
    group by country order by visits desc, country asc limit 15`, [id]);
  const countryRows = countries.length ? countries.map(c => `<tr><td>${esc(c.country)}</td><td class="r">${c.visits}</td></tr>`).join("") : '<tr><td colspan="2" class="muted">Your country report will appear as visitors use your seller account.</td></tr>';
  res.page("Account traffic", `
<h1>Account traffic</h1>
<p class="muted">Traffic recorded while signed in to your seller account. This report is private to your account and does not show other sellers' activity.</p>
<div class="stats">
 <div class="stat"><span>Live account visitors</span><strong>${totals.live}</strong></div>
 <div class="stat"><span>Visits today</span><strong>${totals.today}</strong></div>
 <div class="stat"><span>Last 7 days</span><strong>${totals.last7}</strong></div>
 <div class="stat"><span>Last 30 days</span><strong>${totals.last30}</strong></div>
</div>
<div class="card"><h2>All-time visits</h2><strong>${totals.all_time}</strong><p class="muted small">Unique signed-in browser visits per day since tracking was enabled.</p></div>
<div class="card"><h2>Visitors by country</h2><p class="muted small">Last 30 days</p><div class="scroll"><table><tr><th>Country</th><th class="r">Visits</th></tr>${countryRows}</table></div></div>
<div class="card"><p class="muted small">This counts activity inside your signed-in seller workspace, not public product-page visitors. Country is estimated using ipwho.is. Raw IP addresses are not stored.</p></div>`);
}));

module.exports = router;
