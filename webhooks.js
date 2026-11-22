const router = require("express").Router();
const crypto = require("crypto");
const { pool } = require("./db");
const { toCents } = require("./util");

const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";

function validSignature(raw, header) {
  if (!SECRET || !header) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(raw).digest("base64");
  return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

async function findVendor(client, cache, name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;
  if (!(key in cache)) {
    const r = await client.query(
      "select id, commission_rate from users where role='seller' and status in ('approved','suspended') and lower(shop_name)=$1", [key]);
    cache[key] = r.rows[0] || null;
  }
  return cache[key];
}

// Sum line amounts per vendor. Products whose vendor is not a seller (your own products) are ignored.
async function totalsByVendor(client, items, amountOf) {
  const cache = {};
  const totals = new Map();
  for (const it of items || []) {
    const v = await findVendor(client, cache, it.vendor);
    if (!v) continue;
    const t = totals.get(v.id) || { vendor: v, cents: 0 };
    t.cents += amountOf(it);
    totals.set(v.id, t);
  }
  return [...totals.values()];
}

async function saveRow(client, r) {
  await client.query(
    `insert into earnings (user_id, order_id, order_name, order_date, currency, kind, source_id,
                           gross_cents, rate, commission_cents, earning_cents)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (source_id, user_id, kind) do nothing`,
    [r.userId, r.orderId, r.orderName, r.date, r.currency, r.kind, r.sourceId, r.gross, r.rate, r.commission, r.earning]
  );
}

async function handleSale(client, order) {
  const groups = await totalsByVendor(client, order.line_items, (it) => toCents(it.price) * (it.quantity || 0) - toCents(it.total_discount));
  for (const g of groups) {
    const rate = parseFloat(g.vendor.commission_rate);
    const commission = Math.round((g.cents * rate) / 100);
    await saveRow(client, {
      userId: g.vendor.id, orderId: String(order.id), orderName: order.name,
      date: order.processed_at || order.created_at, currency: order.currency,
      kind: "sale", sourceId: String(order.id), gross: g.cents, rate, commission, earning: g.cents - commission,
    });
  }
}

async function handleRefund(client, refund) {
  const items = (refund.refund_line_items || []).map((r) => ({
    vendor: r.line_item && r.line_item.vendor,
    amount: r.subtotal != null ? toCents(r.subtotal) : toCents(r.line_item && r.line_item.price) * (r.quantity || 0),
    currency: r.subtotal_set && r.subtotal_set.shop_money && r.subtotal_set.shop_money.currency_code,
  }));
  const groups = await totalsByVendor(client, items, (it) => it.amount);
  const orderId = String(refund.order_id);
  for (const g of groups) {
    const prev = await client.query(
      "select rate, order_name, currency from earnings where order_id=$1 and user_id=$2 and kind='sale' limit 1", [orderId, g.vendor.id]);
    const rate = prev.rows[0] ? parseFloat(prev.rows[0].rate) : parseFloat(g.vendor.commission_rate);
    const commission = Math.round((g.cents * rate) / 100);
    await saveRow(client, {
      userId: g.vendor.id, orderId, orderName: prev.rows[0] ? prev.rows[0].order_name : "Order " + orderId,
      date: refund.processed_at || refund.created_at, currency: prev.rows[0] ? prev.rows[0].currency : null,
      kind: "refund", sourceId: String(refund.id), gross: -g.cents, rate, commission: -commission, earning: -(g.cents - commission),
    });
  }
}

// Shopify webhook endpoint: POST /webhooks/shopify  (topics: orders/paid, refunds/create)
router.post("/shopify", require("express").raw({ type: "application/json", limit: "5mb" }), async (req, res) => {
  if (!validSignature(req.body, req.get("X-Shopify-Hmac-Sha256"))) return res.status(401).send("Invalid signature");

  const topic = req.get("X-Shopify-Topic");
  let body;
  try { body = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).send("Bad JSON"); }
  const hookId = req.get("X-Shopify-Webhook-Id") || `${topic}:${body.id}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Shopify can deliver the same webhook more than once; process each only once
    const seen = await client.query("insert into processed_webhooks (id, topic) values ($1,$2) on conflict do nothing returning id", [hookId, topic]);
    if (!seen.rowCount) { await client.query("ROLLBACK"); return res.sendStatus(200); }
    if (topic === "orders/paid") await handleSale(client, body);
    else if (topic === "refunds/create") await handleRefund(client, body);
    await client.query("COMMIT");
    res.sendStatus(200);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("webhook error", e);
    res.sendStatus(500); // Shopify will retry
  } finally {
    client.release();
  }
});

module.exports = router;
