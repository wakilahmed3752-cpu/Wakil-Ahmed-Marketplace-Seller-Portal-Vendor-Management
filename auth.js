const router = require("express").Router();
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { q } = require("./db");
const { wrap } = require("./util");
const { esc, csrfField } = require("./views");

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const DUMMY = bcrypt.hashSync("timing-protection-only", 12);
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

router.get("/", (req, res) => {
  const u = req.session.user;
  if (!u) return res.redirect("/login");
  res.redirect(u.role === "admin" ? "/admin" : "/seller");
});

// ---------- Register ----------
const registerForm = (csrf, v = {}, errs = []) => `
<div class="card narrow">
  <h1>Become a seller</h1>
  <p class="muted">Apply to sell on our marketplace. We review every application and email you the decision.</p>
  ${errs.length ? `<div class="flash flash-error"><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
  <form method="post" action="/register">
    ${csrfField(csrf)}
    <label>Full name *<input name="name" required maxlength="80" value="${esc(v.name)}" autocomplete="name"></label>
    <label>Email *<input type="email" name="email" required maxlength="254" value="${esc(v.email)}" autocomplete="email"></label>
    <label>Phone / WhatsApp *<input name="phone" required maxlength="40" value="${esc(v.phone)}" autocomplete="tel"></label>
    <label>Shop / brand name * <small>(shown on your products)</small><input name="shop_name" required maxlength="60" value="${esc(v.shop_name)}"></label>
    <label>What will you sell? *<input name="category" required maxlength="120" value="${esc(v.category)}" placeholder="e.g. spices, snacks, handmade items"></label>
    <label>Password * <small>(at least 10 characters)</small><input type="password" name="password" required minlength="10" maxlength="100" autocomplete="new-password"></label>
    <label>Confirm password *<input type="password" name="password2" required minlength="10" maxlength="100" autocomplete="new-password"></label>
    <label class="check"><input type="checkbox" name="terms" value="1" required>
      <span>I agree to the seller terms, including the marketplace commission on each sale.</span></label>
    <button class="btn btn-block">Submit application</button>
  </form>
  <p class="muted center">Already approved? <a href="/login">Sign in</a></p>
</div>`;

router.get("/register", (req, res) => res.page("Become a seller", registerForm(res.locals.csrf), {
  indexable: true,
  description: "Apply to become a seller on Wakil Ahmed Marketplace. US-based sellers can submit a shop application, list approved products, ship orders with carrier tracking, and manage marketplace earnings."
}));

router.post(
  "/register",
  limiter,
  wrap(async (req, res) => {
    const b = req.body;
    const v = {
      name: (b.name || "").trim(),
      email: (b.email || "").trim().toLowerCase(),
      phone: (b.phone || "").trim(),
      shop_name: (b.shop_name || "").trim(),
      category: (b.category || "").trim(),
    };
    const errs = [];
    if (v.name.length < 2) errs.push("Please enter your full name.");
    if (!emailOk(v.email)) errs.push("Please enter a valid email address.");
    if (v.phone.length < 6) errs.push("Please enter a phone or WhatsApp number.");
    if (v.shop_name.length < 2) errs.push("Please enter your shop or brand name.");
    if (v.category.length < 2) errs.push("Please tell us what you will sell.");
    if ((b.password || "").length < 10) errs.push("Password must be at least 10 characters.");
    if (b.password !== b.password2) errs.push("Passwords do not match.");
    if (!b.terms) errs.push("You must accept the seller terms.");
    if (errs.length) return res.status(400).page("Become a seller", registerForm(res.locals.csrf, v, errs));

    try {
      const hash = await bcrypt.hash(b.password, 12);
      await q(
        `insert into users (email, password_hash, role, name, shop_name, phone, category, status)
         values ($1,$2,'seller',$3,$4,$5,$6,'pending')`,
        [v.email, hash, v.name, v.shop_name, v.phone, v.category]
      );
    } catch (e) {
      if (e.code === "23505")
        return res.status(400).page("Become a seller", registerForm(res.locals.csrf, v, ["An account with that email or shop name already exists."]));
      throw e;
    }
    res.page(
      "Application received",
      `<div class="card narrow center"><h1>Application received</h1>
       <p>Thank you, ${esc(v.name)}. We will review your application and email you at <strong>${esc(v.email)}</strong>.</p>
       <p class="muted">You can sign in once your account is approved.</p></div>`
    );
  })
);

// ---------- Login ----------
const loginForm = (csrf, err = "", email = "") => `
<div class="card narrow">
  <h1>Seller sign in</h1>
  ${err ? `<div class="flash flash-error">${esc(err)}</div>` : ""}
  <form method="post" action="/login">
    ${csrfField(csrf)}
    <label>Email<input type="email" name="email" required value="${esc(email)}" autocomplete="email"></label>
    <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
    <button class="btn btn-block">Sign in</button>
  </form>
  <p class="muted center">New here? <a href="/register">Apply to become a seller</a></p>
</div>`;

router.get("/login", (req, res) => res.page("Sign in", loginForm(res.locals.csrf)));

router.post(
  "/login",
  limiter,
  wrap(async (req, res, next) => {
    const email = (req.body.email || "").trim().toLowerCase();
    const fail = (msg) => res.status(401).page("Sign in", loginForm(res.locals.csrf, msg, email));
    const { rows } = await q("select * from users where lower(email) = $1", [email]);
    const u = rows[0];
    const ok = await bcrypt.compare(req.body.password || "", u ? u.password_hash : DUMMY);
    if (!u || !ok) return fail("Incorrect email or password.");
    if (u.status === "pending") return fail("Your application is still under review. We will email you once it is approved.");
    if (u.status !== "approved") return fail("This account is not active. Please contact the marketplace.");
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = { id: u.id, role: u.role, name: u.name };
      req.session.save((e2) => (e2 ? next(e2) : res.redirect("/")));
    });
  })
);

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("sid");
    res.redirect("/login");
  });
});

module.exports = router;
