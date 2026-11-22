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
    const { rows: recent } = await q("select * from earnings where user_id=$1 order by order_date desc nulls last, id desc limit 10", [id]);
    const { rows: pays } = await q("select * from payouts where user_id=$1 order by id desc limit 10", [id]);
    const { rows: [me] } = await q("select shop_name, commission_rate from users where id=$1", [id]);
    const cur = t.cur || "";
    res.page("Dashboard", `
<h1>${esc(me.shop_name)}</h1>
<div class="stats">
  <div class="stat"><span>Balance owed to you</span><strong>${money(t.unpaid, cur)}</strong></div>
  <div class="stat"><span>Total paid out</span><strong>${money(t.paid, cur)}</strong></div>
  <div class="stat"><span>Net sales</span><strong>${money(t.sales, cur)}</strong></div>
  <div class="stat"><span>Commission (${esc(me.commission_rate)}%)</span><strong>${money(t.commission, cur)}</strong></div>
</div>
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

module.exports = router;
