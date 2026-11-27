const crypto = require("crypto");
const { q } = require("./db");

const hashVisitor = (id) => crypto.createHmac("sha256", process.env.SESSION_SECRET).update(id).digest("hex");

async function countryFor(ip) {
  if (!ip || ip === "::1" || /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return { country: "Local / unknown", code: null };
  try {
    const response = await fetch("https://ipwho.is/" + encodeURIComponent(ip), { signal: AbortSignal.timeout(2500) });
    const data = await response.json();
    if (data.success && data.country) return { country: data.country, code: data.country_code || null };
  } catch (_) {}
  return { country: "Unknown", code: null };
}

async function track(req, res, next) {
  if (req.method !== "GET" || !req.session || req.path.startsWith("/static/") ||
      ["/healthz", "/robots.txt", "/sitemap.xml"].includes(req.path) || req.path.startsWith("/webhooks")) return next();
  const ua = req.get("user-agent") || "";
  if (/bot|crawler|spider|slurp|facebookexternalhit|preview/i.test(ua)) return next();
  if (!req.session.analyticsVisitorId) req.session.analyticsVisitorId = crypto.randomBytes(24).toString("hex");
  const visitorHash = hashVisitor(req.session.analyticsVisitorId);
  const userId = req.session.user && Number.isInteger(Number(req.session.user.id)) ? Number(req.session.user.id) : null;
  const visitDate = new Date().toISOString().slice(0, 10);
  const path = String(req.path || "/").slice(0, 250);
  const ip = String(req.ip || "").replace(/^::ffff:/, "");
  try {
    const existing = await q("select country from portal_visits where visitor_hash=$1 and visit_date=$2", [visitorHash, visitDate]);
    let geo = existing.rows[0] ? { country: existing.rows[0].country, code: null } : await countryFor(ip);
    await q(
      `insert into portal_visits (visitor_hash, visit_date, user_id, country, country_code, last_path, last_seen)
       values ($1,$2,$3,$4,$5,$6,now())
       on conflict (visitor_hash, visit_date) do update set
         user_id=coalesce(excluded.user_id, portal_visits.user_id),
         country=case when portal_visits.country='Unknown' then excluded.country else portal_visits.country end,
         country_code=coalesce(portal_visits.country_code, excluded.country_code),
         last_path=excluded.last_path, last_seen=now()`,
      [visitorHash, visitDate, userId, geo.country, geo.code, path]
    );
  } catch (error) {
    console.error("Portal traffic tracking error:", error.message);
  }
  next();
}

module.exports = { track };
