const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const PgStore = require("connect-pg-simple")(session);
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const path = require("path");
const { pool, q, migrate } = require("./db");
const { layout } = require("./views");

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy
app.use(helmet());

// Webhooks need the raw body, so they are mounted before the form parser
app.use("/webhooks", require("./webhooks"));

app.get("/static/style.css", (_req, res) => res.sendFile(path.join(__dirname, "style.css"), { maxAge: "1d" }));
app.use(express.urlencoded({ extended: false, limit: "50kb" }));

app.use(
  session({
    store: new PgStore({ pool, tableName: "session" }),
    name: "sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 },
  })
);

// CSRF protection, flash messages, and the res.page() helper
app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString("hex");
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;

  if (req.method === "POST") {
    const t = String(req.body._csrf || "");
    const ok = t.length === req.session.csrf.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(req.session.csrf));
    if (!ok) return res.status(403).send("Your session expired. Go back, refresh the page, and try again.");
  }
  res.page = (title, body) =>
    res.send(layout({ title, user: req.session.user, body, csrf: res.locals.csrf, flash: res.locals.flash }));
  next();
});

app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send([
    "User-agent: *",
    "Allow: /register",
    "Allow: /login",
    "Disallow: /seller",
    "Disallow: /admin",
    "Disallow: /webhooks",
    "Disallow: /healthz",
    "Sitemap: https://seller.wakilahmed.com/sitemap.xml",
    ""
  ].join("\\n"));
});
app.get("/sitemap.xml", (_req, res) => {
  res.type("application/xml").send([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url><loc>https://seller.wakilahmed.com/register</loc></url>',
    '</urlset>'
  ].join("\\n"));
});
app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/googlef773f6d44fa4fd9f.html", (_req, res) => res.type("text/plain").send("google-site-verification: googlef773f6d44fa4fd9f.html"));
app.use("/", require("./auth"));
app.use("/seller", require("./seller"));
app.use("/admin", require("./admin"));

app.use((req, res) => res.status(404).page("Not found", "<div class='card'><h1>Page not found</h1><p><a href='/'>Go home</a></p></div>"));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).page("Error", "<div class='card'><h1>Something went wrong</h1><p>Please try again.</p></div>");
});

async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const pass = process.env.ADMIN_PASSWORD || "";
  if (!email || pass.length < 10) return console.log("No admin created (set ADMIN_EMAIL and a 10+ character ADMIN_PASSWORD).");
  const hash = await bcrypt.hash(pass, 12);
  const r = await q(
    `insert into users (email, password_hash, role, name, status) values ($1,$2,'admin','Marketplace admin','approved')
     on conflict (lower(email)) do nothing`, [email, hash]);
  if (r.rowCount) console.log("Admin account created for " + email);
}

(async () => {
  for (const k of ["DATABASE_URL", "SESSION_SECRET"]) if (!process.env[k]) throw new Error(`Missing environment variable ${k}`);
  await migrate();
  await ensureAdmin();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("Marketplace running on port " + port));
})().catch((e) => { console.error(e); process.exit(1); });
