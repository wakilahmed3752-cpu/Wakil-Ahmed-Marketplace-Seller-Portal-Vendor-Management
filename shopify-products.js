const { q } = require("./db");

let cachedShopifyToken = null;
let cachedShopifyTokenExpiresAt = 0;
let tokenRequestInFlight = null;

const shopifyDomain = () => (process.env.SHOPIFY_STORE_DOMAIN || "")
  .trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");

const shopifyConfigured = () => Boolean(
  shopifyDomain() &&
  (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
    (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET))
);

async function getShopifyAccessToken() {
  if (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) return process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET || !shopifyDomain()) {
    throw new Error("Shopify credentials are incomplete. Configure the store domain, client ID, and client secret in Render.");
  }
  if (cachedShopifyToken && Date.now() < cachedShopifyTokenExpiresAt - 60000) return cachedShopifyToken;
  if (tokenRequestInFlight) return tokenRequestInFlight;

  tokenRequestInFlight = (async () => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET
    });
    const response = await fetch("https://" + shopifyDomain() + "/admin/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(20000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      const reason = payload.error_description || payload.error || ("HTTP " + response.status);
      throw new Error("Shopify authentication failed: " + reason);
    }
    cachedShopifyToken = payload.access_token;
    cachedShopifyTokenExpiresAt = Date.now() + (Number(payload.expires_in) || 86399) * 1000;
    return cachedShopifyToken;
  })();

  try { return await tokenRequestInFlight; }
  finally { tokenRequestInFlight = null; }
}

async function graph(query, variables) {
  if (!shopifyConfigured()) throw new Error("Shopify Admin API credentials are not configured in Render.");
  const version = process.env.SHOPIFY_API_VERSION || "2026-10";
  const accessToken = await getShopifyAccessToken();
  const response = await fetch("https://" + shopifyDomain() + "/admin/api/" + version + "/graphql.json", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errors?.length) {
    throw new Error(payload.errors?.map(x => x.message).join("; ") || ("Shopify API HTTP " + response.status));
  }
  return payload.data;
}

function directImageUrl(value) {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      !/(facebook|fbcdn|instagram|tiktok|pinterest)/i.test(u.hostname) &&
      /\.(jpg|jpeg|png|webp|gif)$/i.test(u.pathname);
  } catch (_) { return false; }
}

async function publishApprovedSubmission(id) {
  const found = await q(
    "select p.*, u.shop_name, u.account_type from seller_product_submissions p join users u on u.id=p.seller_id where p.id=$1 and p.status='approved'",
    [id]
  );
  const p = found.rows[0];
  if (!p) throw new Error("Approved listing was not found.");
  if (p.shopify_published_at) return { alreadyPublished: true };
  if (!shopifyConfigured()) throw new Error("Shopify Admin API credentials are not configured in Render.");

  let productId = p.shopify_product_id;
  if (!productId) {
    const media = directImageUrl(p.image_url)
      ? [{ mediaContentType: "IMAGE", originalSource: p.image_url, alt: p.title }]
      : [];
    const created = await graph(
      "mutation CreateMarketplaceProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {" +
      " productCreate(product: $product, media: $media) {" +
      " product { id onlineStoreUrl variants(first: 1) { nodes { id } } } userErrors { field message } } }",
      { product: {
          title: p.title,
          descriptionHtml: "<p>" + String(p.description).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>") + "</p>",
          vendor: p.shop_name || "Wakil Ahmed Marketplace Seller",
          productType: p.category,
          status: "ACTIVE",
          tags: ["marketplace-seller", p.account_type === "vendor" ? "business-vendor" : "individual-seller", "portal-submission-" + p.id]
        }, media }
    );
    const result = created.productCreate;
    if (result.userErrors?.length) throw new Error(result.userErrors.map(x => x.message).join("; "));
    if (!result.product?.id) throw new Error("Shopify did not return a product ID.");
    productId = result.product.id;
    await q("update seller_product_submissions set shopify_product_id=$1, shopify_product_url=$2, shopify_sync_error=null, updated_at=now() where id=$3",
      [productId, result.product.onlineStoreUrl || null, id]);

  }

  const productData = await graph(
    "query MarketplaceProductVariant($id: ID!) { product(id: $id) { variants(first: 1) { nodes { id inventoryItem { id } } } } }",
    { id: productId }
  );
  const variant = productData.product?.variants?.nodes?.[0];
  if (!variant?.id || !variant.inventoryItem?.id) throw new Error("Shopify product variant could not be loaded.");
  const updated = await graph(
    "mutation UpdateMarketplaceVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {" +
    " productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } } }",
    { productId, variants: [{
      id: variant.id,
      price: (Number(p.price_cents) / 100).toFixed(2),
      inventoryItem: { sku: p.sku || ("WAM-" + p.id), tracked: true }
    }] }
  );
  const variantErrors = updated.productVariantsBulkUpdate.userErrors || [];
  if (variantErrors.length) throw new Error(variantErrors.map(x => x.message).join("; "));

  const locations = await graph("query { locations(first: 25) { nodes { id name isActive } } }", {});
  const location = locations.locations.nodes.find(x => x.isActive);
  if (!location) throw new Error("No active Shopify inventory location was found.");
  const activated = await graph(
    "mutation ActivateMarketplaceInventory($inventoryItemId: ID!, $locationId: ID!) {" +
    " inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) { userErrors { field message } } }",
    { inventoryItemId: variant.inventoryItem.id, locationId: location.id }
  );
  const activationErrors = activated.inventoryActivate.userErrors || [];
  if (activationErrors.length) throw new Error(activationErrors.map(x => x.message).join("; "));
  const stock = await graph(
    "mutation SetMarketplaceInventory($input: InventorySetQuantitiesInput!) {" +
    " inventorySetQuantities(input: $input) { userErrors { field message } } }",
    { input: {
      name: "available",
      reason: "correction",
      quantities: [{ inventoryItemId: variant.inventoryItem.id, locationId: location.id, quantity: Number(p.inventory_quantity) }]
    } }
  );
  const stockErrors = stock.inventorySetQuantities.userErrors || [];
  if (stockErrors.length) throw new Error(stockErrors.map(x => x.message).join("; "));

  const publications = await graph("query { publications(first: 50) { nodes { id name } } }", {});
  const onlineStore = publications.publications.nodes.find(x => x.name.toLowerCase() === "online store");
  if (!onlineStore) throw new Error("Shopify Online Store sales channel was not found.");
  const published = await graph(
    "mutation PublishMarketplaceProduct($id: ID!, $input: [PublicationInput!]!) {" +
    " publishablePublish(id: $id, input: $input) { userErrors { field message } } }",
    { id: productId, input: [{ publicationId: onlineStore.id }] }
  );
  const errors = published.publishablePublish.userErrors || [];
  if (errors.length) throw new Error(errors.map(x => x.message).join("; "));
  const finalProduct = await graph("query MarketplacePublishedProduct($id: ID!) { product(id: $id) { onlineStoreUrl } }", { id: productId });
  await q("update seller_product_submissions set shopify_product_url=$1, shopify_published_at=now(), shopify_sync_error=null, updated_at=now() where id=$2", [finalProduct.product?.onlineStoreUrl || null, id]);
  return { productId };
}

module.exports = { publishApprovedSubmission, shopifyConfigured };
