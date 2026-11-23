const router = require("express").Router();
const { pool, q } = require("./db");
const { wrap, requireRole } = require("./util");
const { esc, money, date, csrfField } = require("./views");

router.use(requireRole("admin"));

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

module.exports = router;
