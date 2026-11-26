const router = require("express").Router();
const { q } = require("./db");
const { wrap, requireRole } = require("./util");
const { esc, csrfField } = require("./views");
router.use(requireRole("seller"));
router.get("/", wrap(async (req,res) => {
  const {rows:[u]} = await q("select phone from users where id=$1",[req.session.user.id]);
  res.page("Payout details", '<div class="card narrow"><h1>Payout details</h1><p class="muted">Worldwide bank account collection is temporarily disabled while a secure, supported payout provider is selected. Please do not send account numbers, IBANs, SWIFT codes or bank passwords through this portal.</p><form method="post" action="/seller/profile">' + csrfField(res.locals.csrf) + '<label>Phone / WhatsApp<input name="phone" maxlength="40" value="' + esc(u.phone) + '"></label><button class="btn">Save contact details</button></form><p class="muted small">Your existing payout records are not changed by this update.</p><p><a class="btn" href="/seller/stripe">Connect Stripe for seller payouts</a></p></div>');
}));
router.post("/", wrap(async (req,res) => {
  await q("update users set phone=$1 where id=$2",[(req.body.phone||"").trim().slice(0,40),req.session.user.id]);
  req.session.flash={type:"ok",text:"Contact details saved. Bank details are not being collected."};
  res.redirect("/seller/profile");
}));
module.exports=router;
