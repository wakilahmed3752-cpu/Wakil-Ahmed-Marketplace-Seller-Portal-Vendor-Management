const { q } = require("./db");

// Lets async route handlers pass errors to Express
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Re-checks the account on every request so a suspended seller is locked out immediately
const requireRole = (role) =>
  wrap(async (req, res, next) => {
    const s = req.session.user;
    if (!s) return res.redirect("/login");
    const { rows } = await q("select role, status from users where id = $1", [s.id]);
    const u = rows[0];
    if (!u || u.status !== "approved") {
      return req.session.destroy(() => res.redirect("/login"));
    }
    if (!(Array.isArray(role) ? role.includes(u.role) : u.role === role)) {
      return res.status(403).page("Not allowed", "<div class='card'><h1>Not allowed</h1><p>You do not have access to this page.</p></div>");
    }
    next();
  });

const toCents = (v) => Math.round(parseFloat(v || "0") * 100);

module.exports = { wrap, requireRole, toCents };
