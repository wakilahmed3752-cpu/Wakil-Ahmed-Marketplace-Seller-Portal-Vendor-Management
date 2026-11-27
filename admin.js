const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { pool, q } = require("./db");
const { wrap, requireRole } = require("./util");
const { esc, money, date, csrfField } = require("./views");

router.use(requireRole(["admin", "employee"]));
router.use("/payouts", requireRole("admin"));
router.use("/team", requireRole("admin"));
router.use("/marketing", requireRole("admin"));
router.use("/advertising", requireRole("admin"));
router.use("/sellers/:id/status", requireRole("admin"));
router.use("/sellers/:id/commission", requireRole("admin"));

router.get(
  "/",
  wrap(async (req, res) => {
    const { rows: [s] } = await q(
      `select (select count(*) from users where role='seller' and status='pending') pending,
              (select count(*) from users where role='seller' and status='approved') approved,
              coalesce((select sum(earning_cents) from earnings where status='unpaid'),0)::bigint owed,
              coalesce((select sum(commission_cents) from earnings),0)::bigint commission,
              (select max(currency) from earnings) cur`);
    const { rows: monthly } = await q(
      `select to_char(date_trunc('month', order_date), 'Mon') label,
              coalesce(sum(gross_cents),0)::bigint sales
       from earnings where order_date >= date_trunc('month', now()) - interval '5 months'
       group by date_trunc('month', order_date) order by date_trunc('month', order_date)`);
    const maxSales = Math.max(1, ...monthly.map((m) => Number(m.sales)));
    const chart = monthly.length ? monthly.map((m) =>
      `<div class="chart-col"><div class="chart-value">${money(m.sales, s.cur || "")}</div><div class="chart-bar-wrap"><div class="chart-bar" style="height:${Math.max(4, Math.round(Number(m.sales) / maxSales * 100))}%"></div></div><span>${esc(m.label)}</span></div>`
    ).join("") : '<p class="muted">Sales activity will appear here when paid orders arrive.</p>';
    res.page("Overview", `
<h1>Marketplace overview</h1>
<div class="stats">
  <div class="stat"><span>Applications waiting</span><strong>${s.pending}</strong></div>
  <div class="stat"><span>Approved sellers</span><strong>${s.approved}</strong></div>
  <div class="stat"><span>Owed to sellers</span><strong>${money(s.owed, s.cur || "")}</strong></div>
  <div class="stat"><span>Your commission earned</span><strong>${money(s.commission, s.cur || "")}</strong></div>
</div>
<div class="card sales-card"><div class="section-head"><div><h2>Sales performance</h2><p class="muted small">Gross sales · Last 6 months</p></div><span class="chart-key"><i></i> Sales</span></div><div class="sales-chart">${chart}</div></div>
<div class="card"><p><a class="btn" href="/admin/sellers">Review sellers</a> <a class="btn btn-ghost" href="/admin/payouts">Pay sellers</a></p></div>`);
  })
);

// ---------- Sellers ----------
router.get(
  "/sellers",
  wrap(async (req, res) => {
    const { rows } = await q("select * from users where role='seller' order by (status='pending') desc, created_at desc");
    const csrf = res.locals.csrf;
    const body = rows.length
      ? rows
          .map(
            (u) => `<div class="card seller">
  <div class="seller-head"><div><h2>${esc(u.shop_name)}</h2><p class="muted">${esc(u.name)} · ${esc(u.email)} · ${esc(u.phone)}</p>
  <p class="muted">Sells: ${esc(u.category)} · Applied ${date(u.created_at)}</p></div>
  <span class="pill pill-${esc(u.status)}">${esc(u.status)}</span></div>
  <div class="row">
    <form method="post" action="/admin/sellers/${u.id}/status" class="inline">${csrfField(csrf)}
      <select name="status">${["pending", "approved", "rejected", "suspended"]
        .map((s) => `<option ${u.status === s ? "selected" : ""}>${s}</option>`)
        .join("")}</select>
      <button class="btn btn-sm">Update status</button></form>
    <form method="post" action="/admin/sellers/${u.id}/commission" class="inline">${csrfField(csrf)}
      <label class="inl">Commission %<input name="rate" type="number" step="0.01" min="0" max="100" value="${esc(u.commission_rate)}"></label>
      <button class="btn btn-sm btn-ghost">Save rate</button></form>
  </div>
  <p class="muted small">Products must use the exact Vendor name <strong>${esc(u.shop_name)}</strong> in Shopify.</p>
</div>`
          )
          .join("")
      : `<div class="card"><p class="muted">No seller applications yet.</p></div>`;
    res.page("Sellers", `<h1>Sellers</h1>${body}`);
  })
);

router.post(
  "/sellers/:id/status",
  wrap(async (req, res) => {
    const status = req.body.status;
    if (!["pending", "approved", "rejected", "suspended"].includes(status)) return res.redirect("/admin/sellers");
    await q("update users set status=$1 where id=$2 and role='seller'", [status, parseInt(req.params.id, 10)]);
    req.session.flash = { type: "ok", text: "Seller status updated." };
    res.redirect("/admin/sellers");
  })
);

router.post(
  "/sellers/:id/commission",
  wrap(async (req, res) => {
    const rate = parseFloat(req.body.rate);
    if (!(rate >= 0 && rate <= 100)) {
      req.session.flash = { type: "error", text: "Commission must be between 0 and 100." };
      return res.redirect("/admin/sellers");
    }
    await q("update users set commission_rate=$1 where id=$2 and role='seller'", [rate, parseInt(req.params.id, 10)]);
    req.session.flash = { type: "ok", text: "Commission rate saved. It applies to new orders only." };
    res.redirect("/admin/sellers");
  })
);

// ---------- Payouts ----------
router.get(
  "/payouts",
  wrap(async (req, res) => {
    const { rows: due } = await q(
      `select u.id, u.shop_name, u.name, u.payout_method, u.payout_details,
              sum(e.earning_cents)::bigint owed, max(e.currency) cur
       from users u join earnings e on e.user_id=u.id and e.status='unpaid'
       group by u.id having sum(e.earning_cents) > 0 order by owed desc`);
    const { rows: hist } = await q(
      `select p.*, u.shop_name from payouts p join users u on u.id=p.user_id order by p.id desc limit 30`);
    const csrf = res.locals.csrf;
    res.page("Payouts", `
<h1>Payouts</h1>
<p class="muted">Pay the seller by bank transfer or PayPal first, then record it here. This marks their unpaid earnings as paid.</p>
${
  due.length
    ? due
        .map(
          (d) => `<div class="card"><div class="seller-head"><div><h2>${esc(d.shop_name)}</h2>
  <p class="muted">${esc(d.payout_method || "No payout method set")}</p>
  <pre class="details">${esc(d.payout_details || "No payout details provided yet.")}</pre></div>
  <div class="amount">${money(d.owed, d.cur || "")}</div></div>
  <form method="post" action="/admin/payouts/${d.id}" class="row">${csrfField(csrf)}
    <input name="reference" placeholder="Transfer reference (optional)" maxlength="100">
    <button class="btn btn-sm">Mark as paid</button></form></div>`
        )
        .join("")
    : `<div class="card"><p class="muted">No balances to pay right now.</p></div>`
}
<div class="card"><h2>Payout history</h2>${
      hist.length
        ? `<div class="scroll"><table><tr><th>Date</th><th>Seller</th><th>Method</th><th>Reference</th><th class="r">Amount</th></tr>${hist
            .map((p) => `<tr><td>${date(p.created_at)}</td><td>${esc(p.shop_name)}</td><td>${esc(p.method)}</td><td>${esc(p.reference)}</td><td class="r">${money(p.amount_cents, p.currency)}</td></tr>`)
            .join("")}</table></div>`
        : `<p class="muted">No payouts recorded yet.</p>`
    }</div>`);
  })
);

router.post(
  "/payouts/:id",
  wrap(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const reference = (req.body.reference || "").trim().slice(0, 100);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Claim the unpaid rows first so a double-click cannot pay twice
      const { rows } = await client.query(
        "update earnings set status='paid' where user_id=$1 and status='unpaid' returning id, earning_cents, currency", [userId]);
      const total = rows.reduce((a, r) => a + r.earning_cents, 0);
      if (total <= 0) {
        await client.query("ROLLBACK");
        req.session.flash = { type: "error", text: "Nothing to pay for this seller." };
        return res.redirect("/admin/payouts");
      }
      const { rows: [u] } = await client.query("select payout_method from users where id=$1", [userId]);
      const { rows: [p] } = await client.query(
        "insert into payouts (user_id, amount_cents, currency, method, reference) values ($1,$2,$3,$4,$5) returning id",
        [userId, total, rows[0].currency, u ? u.payout_method : null, reference]);
      await client.query("update earnings set payout_id=$1 where id = any($2::int[])", [p.id, rows.map((r) => r.id)]);
      await client.query("COMMIT");
      req.session.flash = { type: "ok", text: "Payout recorded." };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    res.redirect("/admin/payouts");
  })
);

// ---------- All earnings ----------
router.get(
  "/earnings",
  wrap(async (req, res) => {
    const { rows } = await q(
      `select e.*, u.shop_name from earnings e join users u on u.id=e.user_id order by e.order_date desc nulls last, e.id desc limit 300`);
    res.page("Earnings", `<h1>All seller earnings</h1><div class="card">${
      rows.length
        ? `<div class="scroll"><table><tr><th>Date</th><th>Order</th><th>Seller</th><th>Type</th><th class="r">Sales</th><th class="r">Rate</th><th class="r">Commission</th><th class="r">Seller gets</th><th>Status</th></tr>${rows
            .map((r) => `<tr><td>${date(r.order_date)}</td><td>${esc(r.order_name)}</td><td>${esc(r.shop_name)}</td><td>${esc(r.kind)}</td>
            <td class="r">${money(r.gross_cents, r.currency)}</td><td class="r">${esc(r.rate)}%</td><td class="r">${money(r.commission_cents, r.currency)}</td>
            <td class="r">${money(r.earning_cents, r.currency)}</td><td><span class="pill pill-${esc(r.status)}">${esc(r.status)}</span></td></tr>`)
            .join("")}</table></div>`
        : `<p class="muted">No orders recorded yet.</p>`
    }</div>`);
  })
);


// ---------- Admin-only team access ----------
router.get("/team", wrap(async (req, res) => {
  const { rows } = await q("select id, name, email, status, created_at from users where role='employee' order by created_at desc");
  const list = rows.length ? '<div class="scroll"><table><tr><th>Name</th><th>Email</th><th>Status</th><th>Added</th></tr>' + rows.map((u) => '<tr><td>' + esc(u.name) + '</td><td>' + esc(u.email) + '</td><td><span class="pill pill-' + esc(u.status) + '">' + esc(u.status) + '</span></td><td>' + date(u.created_at) + '</td></tr>').join("") + '</table></div>' : '<p class="muted">No employee accounts yet.</p>';
  res.page("Team access", '<h1>Team access</h1><div class="card narrow"><h2>Add an employee</h2><p class="muted small">Employees can view the marketplace overview, seller list and earnings. They cannot manage payouts, change commissions, approve sellers, or manage other accounts.</p><form method="post" action="/admin/team">' + csrfField(res.locals.csrf) + '<label>Employee name<input name="name" required maxlength="80"></label><label>Work email<input type="email" name="email" required maxlength="254"></label><label>Temporary password <small>(10 characters minimum)</small><input type="password" name="password" required minlength="10" maxlength="100"></label><button class="btn btn-block">Create employee account</button></form></div><div class="card"><h2>Employee accounts</h2>' + list + '</div>');
}));

router.post("/team", wrap(async (req, res) => {
  const name = (req.body.name || "").trim().slice(0, 80);
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) {
    req.session.flash = { type: "error", text: "Enter a valid name, email and password of at least 10 characters." };
    return res.redirect("/admin/team");
  }
  const hash = await bcrypt.hash(password, 12);
  try {
    await q("insert into users (email, password_hash, role, name, status) values ($1,$2,'employee',$3,'approved')", [email, hash, name]);
    req.session.flash = { type: "ok", text: "Employee account created. Share the login details with the employee privately." };
  } catch (e) {
    if (e.code === "23505") req.session.flash = { type: "error", text: "That email address is already in use." };
    else throw e;
  }
  res.redirect("/admin/team");
}));

// ---------- Marketing and advertising workspaces ----------
router.get("/marketing", (_req, res) => res.page("Marketing", '<h1>Marketing workspace</h1><p class="muted">Plan and review marketplace marketing activity from one place.</p><div class="stats"><div class="stat"><span>Organic channels</span><strong>SEO & social</strong></div><div class="stat"><span>Campaign planning</span><strong>Available</strong></div><div class="stat"><span>Connected accounts</span><strong>Not connected</strong></div></div><div class="card"><h2>Marketing options</h2><ul><li>Product titles, descriptions and search optimization</li><li>Social content planning for TikTok, Facebook, Instagram and Pinterest</li><li>Email campaign planning and customer announcements</li><li>Campaign performance review when channel data is connected</li></ul><p class="muted small">This workspace does not publish posts or send emails until an approved platform connection is configured.</p></div>'));
router.get("/advertising", (_req, res) => res.page("Advertising", '<h1>Advertising workspace</h1><p class="muted">Organize paid advertising options without changing any live campaigns.</p><div class="stats"><div class="stat"><span>Google Ads</span><strong>Not connected</strong></div><div class="stat"><span>Meta Ads</span><strong>Not connected</strong></div><div class="stat"><span>TikTok Ads</span><strong>Not connected</strong></div></div><div class="card"><h2>Advertising options</h2><ul><li>Google Search and Shopping campaigns</li><li>Facebook and Instagram campaigns</li><li>TikTok advertising campaigns</li><li>Budget, creative and performance planning</li></ul><p class="muted small">No advertising account has been connected and no campaign or spend has been created. Connect an advertising account before launching ads.</p></div>'));


router.use("/traffic", requireRole("admin"));

// ---------- Portal traffic analytics ----------
router.get("/traffic", wrap(async (req, res) => {
  const { rows: [totals] } = await q(`
    select count(*) filter (where visit_date=current_date)::int today,
           count(*) filter (where visit_date >= current_date-6)::int last7,
           count(*) filter (where visit_date >= current_date-29)::int last30,
           count(*)::int all_time,
           count(distinct visitor_hash) filter (where last_seen >= now()-interval '5 minutes')::int live
    from portal_visits`);
  const { rows: countries } = await q(`
    select country, count(*)::int visits
    from portal_visits where visit_date >= current_date-29
    group by country order by visits desc, country asc limit 15`);
  const countryRows = countries.length ? countries.map(c => `<tr><td>${esc(c.country)}</td><td class="r">${c.visits}</td></tr>`).join("") : '<tr><td colspan="2" class="muted">Country data will appear as visitors use the portal.</td></tr>';
  res.page("Portal traffic", `
<h1>Portal traffic</h1>
<p class="muted">Visitor estimates for the entire seller portal. A live visitor is a browser active in the last five minutes. Repeat visits from the same browser count once per day.</p>
<div class="stats">
 <div class="stat"><span>Live visitors now</span><strong>${totals.live}</strong></div>
 <div class="stat"><span>Visits today</span><strong>${totals.today}</strong></div>
 <div class="stat"><span>Last 7 days</span><strong>${totals.last7}</strong></div>
 <div class="stat"><span>Last 30 days</span><strong>${totals.last30}</strong></div>
</div>
<div class="card"><h2>All-time daily visitors</h2><strong>${totals.all_time}</strong><p class="muted small">Unique browser visits per day since tracking was enabled.</p></div>
<div class="card"><h2>Visitors by country</h2><p class="muted small">Last 30 days</p><div class="scroll"><table><tr><th>Country</th><th class="r">Visits</th></tr>${countryRows}</table></div></div>
<div class="card"><p class="muted small">Country is estimated from the visitor's IP address using ipwho.is. The portal stores a one-way hashed visitor identifier, not the raw IP address. Existing visits before this feature launches are not available.</p></div>`);
}));

module.exports = router;
