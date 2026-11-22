# Wakil Ahmed Marketplace – seller portal

Node.js + PostgreSQL backend for sellers, commissions, earnings and payouts.

## What it does
- Sellers apply at `/register`; the admin approves or rejects them at `/admin/sellers`.
- Admin sets each seller's commission rate.
- Shopify sends `orders/paid` and `refunds/create` webhooks to `/webhooks/shopify`.
  Items are matched to sellers by the product **Vendor** field, which must equal the seller's shop name.
- Sellers see balance, orders and payment history. Admin records payouts at `/admin/payouts`.

## Environment variables (set these on Render, never in GitHub)
| Name | Value |
|---|---|
| `DATABASE_URL` | Internal Database URL from your Render Postgres page |
| `SESSION_SECRET` | Any long random string (40+ characters) |
| `ADMIN_EMAIL` | Your admin login email |
| `ADMIN_PASSWORD` | Your admin password (10+ characters) |
| `SHOPIFY_WEBHOOK_SECRET` | Client secret of your Shopify app |
| `NODE_ENV` | `production` |
| `BRAND_NAME` | Optional, shown in the header |

Build command: `npm install`  Start command: `npm start`

## Shopify webhooks
Shopify admin → Settings → Notifications → Webhooks. Add two, format JSON:
- Order payment → `https://YOUR-SERVICE.onrender.com/webhooks/shopify`
- Refund create → same URL
Webhooks created there are signed with your store's webhook signing secret; use that
value for `SHOPIFY_WEBHOOK_SECRET` (shown at the top of the same Webhooks page).

## Not built yet
Seller product listing (draft products sent to Shopify), password reset by email.
