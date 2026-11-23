# Seller Advertising Center setup

The seller portal includes self-service OAuth entry points for Google Ads, Meta Ads, and TikTok Ads. Each connection is stored against the authenticated seller ID. OAuth access and refresh tokens are encrypted at rest using AES-256-GCM.

## Required Render environment variables

Set these values on the seller portal web service. Never commit secrets to GitHub or share them in chat.

- `ADS_TOKEN_ENCRYPTION_KEY`: 64 hexadecimal characters (32 random bytes).
- `GOOGLE_ADS_CLIENT_ID`
- `GOOGLE_ADS_CLIENT_SECRET`
- `GOOGLE_ADS_REDIRECT_URI`: `https://seller.wakilahmed.com/seller/advertising/google/callback`
- `META_ADS_APP_ID`
- `META_ADS_APP_SECRET`
- `META_ADS_REDIRECT_URI`: `https://seller.wakilahmed.com/seller/advertising/meta/callback`
- `TIKTOK_ADS_APP_ID`
- `TIKTOK_ADS_APP_SECRET`
- `TIKTOK_ADS_REDIRECT_URI`: `https://seller.wakilahmed.com/seller/advertising/tiktok/callback`

Register the exact callback URLs in each provider's developer application. The provider apps must be approved for the requested advertising permissions and production OAuth use.

Generate an encryption key using a secure password manager or a cryptographically secure local generator. Example on Node.js: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Important implementation status

The current implementation provides the seller navigation, provider connection initiation, state validation, token exchange, encrypted seller-specific token storage, and disconnect actions.

Before advertising accounts can be actively used, complete and test the provider-specific advertiser/account discovery APIs, seller account selection, token refresh and revocation, and campaign/report endpoints. Google Ads campaign access also requires a Google Ads developer token and any applicable manager-account configuration. Do not enable campaign creation or spend controls until those steps and permission checks are complete.

Connecting an account must never create campaigns, alter budgets, or spend money.
