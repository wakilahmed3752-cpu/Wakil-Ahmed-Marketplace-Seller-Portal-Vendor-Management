const router = require("express").Router();
const { q } = require("./db");
const { wrap, requireRole } = require("./util");
const { esc, date, csrfField } = require("./views");

const currencies = ["USD","EUR","GBP","CAD","AUD","PKR","INR","BDT","AED","SAR","TRY","JPY","CNY","MXN","BRL","NGN","ZAR","CHF","NZD","SGD"];
const categories = ["Clothing & Fashion","Health & Wellness","Grocery & Snacks","Household Essentials","Beauty & Personal Care","Electronics","Home & Kitchen","Toys & Baby","Sports & Outdoors","Handmade & Crafts","Books & Media","Other"];
const safeUrl = (value) => {
  if (!value) return null;
  try { const u = new URL(value); return u.protocol === "https:" ? u.toString() : null; } catch { return null; }
};
const statusPill = (s) => '<span class="pill pill-' + esc(s === "approved" ? "approved" : s === "rejected" ? "rejected" : "pending") + '">' + esc(s) + '</span>';

const seller = requireRole("seller");
const admin = requireRole("admin");

router.use("/seller", seller);
router.get("/seller/products", wrap(async (req, res) => {
  const { rows } = await q("select id,title,category,price,currency,quantity,status,created_at from seller_products where seller_id=$1 order by id desc", [req.session.user.id]);
  const list = rows.length ? '<div class="scroll"><table><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th>Submitted</th></tr>' + rows.map(p => '<tr><td><strong>' + esc(p.title) + '</strong></td><td>' + esc(p.category) + '</td><td>' + Number(p.price).toFixed(2) + ' ' + esc(p.currency) + '</td><td>' + p.quantity + '</td><td>' + statusPill(p.status) + '</td><td>' + date(p.created_at) + '</td></tr>').join("") + '</table></div>' : '<p class="muted">You have not submitted any products yet. Use the form below to add your first listing.</p>';
  res.page("Products", '<h1>My products</h1><p class="muted">Sellers worldwide can submit products for marketplace review. Every listing is reviewed by the marketplace admin before approval. Approval here does not publish the product to Shopify.</p><div class="card"><h2>Your listings</h2>' + list + '</div>' + productForm(res.locals.csrf));
}));
function productForm(csrf) {
  return '<div class="card"><h2>Add a product</h2><form method="post" action="/seller/products">' + csrfField(csrf) +
    '<label>Product name *<input name="title" required maxlength="160"></label>' +
    '<label>Description *<textarea name="description" required rows="5" maxlength="5000"></textarea></label>' +
    '<label>Category *<select name="category" required><option value="">Choose a category</option>' + categories.map(c => '<option>' + esc(c) + '</option>').join("") + '</select></label>' +
    '<label>Brand / manufacturer<input name="brand" maxlength="100"></label>' +
    '<label>SKU or product code<input name="sku" maxlength="80"></label>' +
    '<div class="row"><label>Price *<input name="price" type="number" min="0.01" max="10000000" step="0.01" required></label><label>Currency *<select name="currency" required>' + currencies.map(c => '<option ' + (c === "USD" ? "selected" : "") + '>' + c + '</option>').join("") + '</select></label></div>' +
    '<label>Available quantity *<input name="quantity" type="number" min="0" max="1000000" step="1" value="0" required></label>' +
    '<label>Seller country *<input name="seller_country" required maxlength="80" placeholder="e.g. United States, Pakistan, India"></label>' +
    '<label>Countries you can ship to *<input name="ships_to" required maxlength="500" placeholder="e.g. United States, Canada, Worldwide"></label>' +
    '<label>Product image URL (HTTPS only)<input name="image_url" type="url" maxlength="1000" placeholder="https://..."></label>' +
    '<p class="muted small">New listings are saved as Pending review. Do not enter bank account details here.</p><button class="btn">Submit product for review</button></form></div>';
}
router.post("/seller/products", wrap(async (req, res) => {
  const b = req.body;
  const title = (b.title || "").trim().slice(0,160);
  const description = (b.description || "").trim().slice(0,5000);
  const category = (b.category || "").trim();
  const brand = (b.brand || "").trim().slice(0,100) || null;
  const sku = (b.sku || "").trim().slice(0,80) || null;
  const price = Number(b.price);
  const currency = (b.currency || "").trim().toUpperCase();
  const quantity = Number(b.quantity);
  const sellerCountry = (b.seller_country || "").trim().slice(0,80);
  const shipsTo = (b.ships_to || "").trim().slice(0,500);
  const imageUrl = safeUrl((b.image_url || "").trim());
  const errors = [];
  if (title.length < 2) errors.push("Enter a product name.");
  if (description.length < 10) errors.push("Enter a product description of at least 10 characters.");
  if (!categories.includes(category)) errors.push("Choose a valid product category.");
  if (!Number.isFinite(price) || price <= 0 || price > 10000000) errors.push("Enter a valid product price.");
  if (!currencies.includes(currency)) errors.push("Choose a supported currency.");
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) errors.push("Enter a valid stock quantity.");
  if (sellerCountry.length < 2) errors.push("Enter the seller country.");
  if (shipsTo.length < 2) errors.push("Enter the countries you can ship to.");
  if ((b.image_url || "").trim() && !imageUrl) errors.push("Product image links must use HTTPS.");
  if (errors.length) {
    req.session.flash = { type:"error", text:errors.join(" ") };
    return res.redirect("/seller/products");
  }
  await q(`insert into seller_products (seller_id,title,description,category,brand,sku,price,currency,quantity,seller_country,ships_to,image_url,status)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')`,
    [req.session.user.id,title,description,category,brand,sku,price,currency,quantity,sellerCountry,shipsTo,imageUrl]);
  req.session.flash = { type:"ok", text:"Product submitted. It is now waiting for marketplace admin review." };
  res.redirect("/seller/products");
}));

router.use("/admin", admin);
router.get("/admin/products", wrap(async (req,res) => {
  const { rows } = await q(`select p.*,u.shop_name,u.name seller_name,u.email seller_email
    from seller_products p join users u on u.id=p.seller_id
    order by (p.status='pending') desc,p.created_at desc limit 500`);
  const cards = rows.length ? rows.map(p => '<div class="card"><div class="seller-head"><div><h2>' + esc(p.title) + '</h2><p class="muted">' + esc(p.shop_name) + ' · ' + esc(p.seller_name) + ' · ' + esc(p.seller_email) + '</p><p class="muted small">' + esc(p.category) + ' · ' + Number(p.price).toFixed(2) + ' ' + esc(p.currency) + ' · Stock ' + p.quantity + ' · ' + esc(p.seller_country) + '</p></div>' + statusPill(p.status) + '</div><p>' + esc(p.description) + '</p><p class="muted small">Ships to: ' + esc(p.ships_to) + (p.sku ? ' · SKU: ' + esc(p.sku) : '') + (p.image_url ? ' · <a href="' + esc(p.image_url) + '" target="_blank" rel="noopener">Product image</a>' : '') + '</p>' + (p.status === "pending" ? '<div class="row"><form method="post" action="/admin/products/' + p.id + '/review">' + csrfField(res.locals.csrf) + '<input type="hidden" name="decision" value="approved"><button class="btn btn-sm">Approve listing</button></form><form method="post" action="/admin/products/' + p.id + '/review">' + csrfField(res.locals.csrf) + '<input type="hidden" name="decision" value="rejected"><button class="btn btn-sm btn-ghost">Reject</button></form></div>' : '') + '</div>').join("") : '<div class="card"><p class="muted">No product submissions yet.</p></div>';
  res.page("Product review", '<h1>Product review</h1><p class="muted">Review seller submissions from all supported countries. Approving a listing records marketplace approval only. Shopify publishing and seller payouts remain disconnected.</p>' + cards);
}));
router.post("/admin/products/:id/review", wrap(async (req,res) => {
  const decision = req.body.decision;
  const id = Number.parseInt(req.params.id,10);
  if (!Number.isInteger(id) || !["approved","rejected"].includes(decision)) {
    req.session.flash = {type:"error",text:"Choose a valid review decision."};
    return res.redirect("/admin/products");
  }
  const result = await q("update seller_products set status=$1,reviewed_by=$2,reviewed_at=now() where id=$3 and status='pending' returning id", [decision,req.session.user.id,id]);
  req.session.flash = result.rowCount ? {type:"ok",text:"Product listing marked " + decision + "."} : {type:"error",text:"This product was already reviewed or could not be found."};
  res.redirect("/admin/products");
}));
module.exports = router;
