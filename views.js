const BRAND = process.env.BRAND_NAME || "Wakil Ahmed Marketplace";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const money = (cents, cur = "") =>
  (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
  (cur ? " " + esc(cur) : "");

const date = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const csrfField = (t) => `<input type="hidden" name="_csrf" value="${esc(t)}">`;

function layout({ title, user, body, csrf, flash, pathname = "/", seo = {} }) {
  const out = `<form method="post" action="/logout" class="inline">${csrfField(csrf)}<button class="linkbtn">Sign out</button></form>`;
  let nav;
  if (!user) nav = `<a href="/login">Sign in</a><a class="btn btn-sm" href="/register">Become a seller</a>`;
  else if (user.role === "admin")
    nav = `<a href="/admin">Overview</a><a href="/admin/sellers">Sellers</a><a href="/admin/payouts">Payouts</a><a href="/admin/earnings">Earnings</a>${out}`;
  else nav = `<a href="/seller">Dashboard</a><a href="/seller/orders">Orders</a><a href="/seller/profile">Payout details</a>${out}`;

  const flashHtml = flash ? `<div class="flash flash-${esc(flash.type)}" role="status">${esc(flash.text)}</div>` : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(seo.description || (seo.indexable ? "Apply to become a seller on Wakil Ahmed Marketplace. Submit your application and learn how the marketplace works." : "Wakil Ahmed Marketplace seller portal."))}">
<meta name="robots" content="${seo.indexable && !user ? "index,follow" : "noindex,nofollow"}">
<link rel="canonical" href="https://seller.wakilahmed.com${esc(pathname)}">
<meta property="og:title" content="${esc(title)} · ${esc(BRAND)}">
<meta property="og:description" content="${esc(seo.description || "Wakil Ahmed Marketplace seller portal.")}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://seller.wakilahmed.com${esc(pathname)}">
<meta property="og:image" content="https://cdn.shopify.com/s/files/1/0905/1081/9694/files/wakil-ahmed-marketplace-social.jpg?v=1795390551">
<meta property="og:image:secure_url" content="https://cdn.shopify.com/s/files/1/0905/1081/9694/files/wakil-ahmed-marketplace-social.jpg?v=1795390551">
<meta property="og:image:alt" content="Wakil Ahmed Marketplace official logo">
<title>${esc(title)} · ${esc(BRAND)}</title>
<link rel="stylesheet" href="/static/style.css">
</head><body>
<header class="top"><div class="wrap bar">
  <a class="brand" href="/">${esc(BRAND)}</a>
  <nav>${nav}</nav>
</div></header>
<main class="wrap">${flashHtml}${body}</main>
<footer class="wrap foot">&copy; ${new Date().getFullYear()} ${esc(BRAND)}</footer>
</body></html>`;
}

module.exports = { layout, esc, money, date, csrfField, BRAND };
