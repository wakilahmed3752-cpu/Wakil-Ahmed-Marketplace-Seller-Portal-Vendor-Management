const BRAND = process.env.BRAND_NAME || "Wakil Ahmed Marketplace";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const money = (cents, cur = "") =>
  (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
  (cur ? " " + esc(cur) : "");

const date = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const csrfField = (t) => '<input type="hidden" name="_csrf" value="' + esc(t) + '">';

function layout({ title, user, body, csrf, flash, pathname = "/", seo = {} }) {
  const out = '<form method="post" action="/logout" class="inline signout">' + csrfField(csrf) + '<button class="linkbtn">Sign out</button></form>';
  let nav = "";
  let section = "Marketplace";
  if (!user) {
    nav = '<a href="/login">Sign in</a><a class="btn btn-sm" href="/register">Become a seller</a>';
  } else if (user.role === "admin") {
    section = "Administrator";
    nav = '<a href="/admin" class="navlink">Overview</a><a href="/admin/sellers" class="navlink">Sellers</a><a href="/admin/payouts" class="navlink">Payouts</a><a href="/admin/earnings" class="navlink">Earnings</a><a href="/admin/team" class="navlink">Team access</a><a href="/admin/marketing" class="navlink">Marketing</a><a href="/admin/advertising" class="navlink">Advertising</a>' + out;
  } else if (user.role === "employee") {
    section = "Employee workspace";
    nav = '<a href="/admin" class="navlink">Overview</a><a href="/admin/sellers" class="navlink">Sellers</a><a href="/admin/earnings" class="navlink">Earnings</a>' + out;
  } else {
    section = "Seller workspace";
    nav = '<a href="/seller" class="navlink">Dashboard</a><a href="/seller/products" class="navlink">Products</a><a href="/seller/orders" class="navlink">Orders</a><a href="/seller/inventory" class="navlink">Inventory</a><a href="/seller/marketing" class="navlink">Marketing</a><a href="/seller/advertising" class="navlink">Advertising</a><a href="/seller/profile" class="navlink">Payout details</a>' + out;
  }

  const flashHtml = flash ? '<div class="flash flash-' + esc(flash.type) + '" role="status">' + esc(flash.text) + "</div>" : "";
  const shellClass = user ? "app-shell authenticated" : "app-shell public-shell";
  return '<!doctype html><html lang="en"><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="theme-color" content="#202321">' +
    '<meta name="description" content="' + esc(seo.description || (seo.indexable ? "Apply to become a seller on Wakil Ahmed Marketplace." : "Wakil Ahmed Marketplace seller portal.")) + '">' +
    '<meta name="robots" content="' + (seo.indexable && !user ? "index,follow" : "noindex,nofollow") + '">' +
    '<link rel="canonical" href="https://seller.wakilahmed.com' + esc(pathname) + '">' +
    '<meta property="og:title" content="' + esc(title) + " · " + esc(BRAND) + '">' +
    '<meta property="og:description" content="' + esc(seo.description || "Wakil Ahmed Marketplace seller portal.") + '">' +
    '<meta property="og:type" content="website"><meta property="og:url" content="https://seller.wakilahmed.com' + esc(pathname) + '">' +
    '<meta property="og:image" content="https://seller.wakilahmed.com/static/logo.png"><meta property="og:image:secure_url" content="https://seller.wakilahmed.com/static/logo.png">' +
    '<meta property="og:image:alt" content="Wakil Ahmed Marketplace official logo">' +
    '<title>' + esc(title) + " · " + esc(BRAND) + '</title>' +
    '<link rel="icon" type="image/png" sizes="48x48" href="/static/favicon.png"><link rel="apple-touch-icon" href="/static/logo.png">' +
    '<link rel="stylesheet" href="/static/style.css"></head><body class="' + shellClass + '">' +
    '<header class="top"><div class="top-inner">' +
    '<a class="brand" href="/" aria-label="Wakil Ahmed Marketplace home"><img src="/static/logo.png" alt="" width="42" height="42"><span><strong>' + esc(BRAND) + '</strong><small>' + section + '</small></span></a>' +
    '<div class="top-right">' + (user ? '<span class="welcome">Welcome, ' + esc(user.name || "User") + '</span>' : "") + (!user ? '<nav>' + nav + "</nav>" : "") + '</div></div></header>' +
    (user ? '<aside class="sidebar"><div class="sidebar-label">' + section + '</div><nav class="side-nav">' + nav + '</nav><div class="sidebar-foot"><span class="status-dot"></span> Portal active</div></aside>' : "") +
    '<main class="main-content"><div class="page-wrap">' + flashHtml + body + '</div><footer class="foot">© ' + new Date().getFullYear() + " " + esc(BRAND) + ' <span>Seller Portal</span></footer></main>' +
    '<script>(function(){function addPasswordToggles(){document.querySelectorAll("input[type=password]:not([data-visibility-ready])").forEach(function(input){input.dataset.visibilityReady="true";var wrap=document.createElement("span");wrap.className="password-control";input.parentNode.insertBefore(wrap,input);wrap.appendChild(input);var toggle=document.createElement("button");toggle.type="button";toggle.className="password-toggle";toggle.textContent="Show";toggle.setAttribute("aria-label","Show password");toggle.setAttribute("aria-pressed","false");toggle.addEventListener("click",function(){var reveal=input.type==="password";input.type=reveal?"text":"password";toggle.textContent=reveal?"Hide":"Show";toggle.setAttribute("aria-label",reveal?"Hide password":"Show password");toggle.setAttribute("aria-pressed",String(reveal));input.focus();});wrap.appendChild(toggle);});}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",addPasswordToggles);}else{addPasswordToggles();}})();</script>' +
    '</body></html>';
}

module.exports = { layout, esc, money, date, csrfField, BRAND };
