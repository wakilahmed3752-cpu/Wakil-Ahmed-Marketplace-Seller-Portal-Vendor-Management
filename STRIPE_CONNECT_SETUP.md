# Stripe Connect setup for Wakil Ahmed Marketplace

This integration adds Stripe-hosted Express account onboarding for sellers. It stores only the connected account ID, country, and verification/payout status in the marketplace database. Sellers enter identity and bank details on Stripe-hosted pages.

## Required platform setup

1. Activate Stripe Connect for the Wakil Ahmed LLC Stripe platform account and complete Stripe's platform onboarding.
2. Start with Stripe test mode. Create a restricted-purpose secret key with the minimum permissions required for Connect account creation, account retrieval, and account links. Store it only in the Render service's private Environment settings as `STRIPE_SECRET_KEY`. Never put it in source control, seller-facing settings, or chat.
3. Add `APP_BASE_URL=https://seller.wakilahmed.com` to the Render service environment.
4. Keep the existing Render Free plan. Do not create a new service or database.
5. Deploy to a test environment and verify seller onboarding, refresh, return, country restrictions, and account status before production use.

## Seller flow

1. Seller signs in to the portal.
2. Seller opens **Payout details**, then **Connect Stripe for seller payouts**.
3. Seller enters the two-letter country code for the country where their payout account is registered.
4. The portal creates a Stripe Express connected account and redirects the seller to Stripe-hosted onboarding.
5. Seller supplies identity, business, and bank details directly to Stripe.
6. Stripe returns the seller to the portal, where the portal retrieves and displays verification and payout eligibility status.

Stripe decides which countries and sellers can be onboard. A country code being syntactically valid does not mean Stripe supports that country for this platform.

## Important limits

- This change does not move or split Shopify Payments funds.
- This change does not create transfers or send seller payouts.
- Shopify Basic checkout still pays the Wakil Ahmed LLC Shopify payout account first.
- A compliant funding and transfer/reconciliation workflow must be implemented and tested before the portal can pay sellers.
- Do not enable manual bank detail fields or use the legacy plaintext payout fields.
- Never use live-mode keys until Stripe has approved the platform setup and end-to-end testing has passed.
