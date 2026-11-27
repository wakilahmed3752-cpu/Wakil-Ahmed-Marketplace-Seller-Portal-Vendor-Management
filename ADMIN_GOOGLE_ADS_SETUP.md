# Marketplace admin Google Ads connection

This adds an owner/admin Google Ads OAuth connection that is stored separately from seller advertising connections.

## Render environment variables

Set these on the existing Render service. Keep all secret values private.

- `GOOGLE_ADS_CLIENT_ID`: OAuth web client ID.
- `GOOGLE_ADS_CLIENT_SECRET`: OAuth web client secret.
- `GOOGLE_ADS_ADMIN_REDIRECT_URI`: `https://seller.wakilahmed.com/admin/advertising/google/callback`
- `ADS_TOKEN_ENCRYPTION_KEY`: 64 hexadecimal characters (32 random bytes). The same application encryption key can be used by the seller and marketplace connection modules.

## Google Cloud OAuth client

Add the exact admin callback URL above to the same Web application OAuth client as an additional Authorized redirect URI. Keep the existing seller callback URI too:

`https://seller.wakilahmed.com/seller/advertising/google/callback`

The admin and seller connections use separate callback paths and separate database records. The admin connection is restricted to the admin role.

## Behavior and limits

- Admin opens **Advertising** and connects the marketplace's own Google Ads account.
- OAuth access and refresh tokens are encrypted with AES-256-GCM before database storage.
- The admin connection is stored in `marketplace_ad_accounts`; seller tokens remain in `seller_ad_accounts`.
- Disconnect removes the marketplace token record from the portal database.
- Connecting does not create campaigns, change budgets, or spend money.
- This is an OAuth connection only. Google Ads developer token setup, customer/account discovery, reporting, campaign management, token refresh handling and end-to-end production verification are separate work.
- Do not enable campaign creation or spend until those capabilities are implemented and separately approved.
