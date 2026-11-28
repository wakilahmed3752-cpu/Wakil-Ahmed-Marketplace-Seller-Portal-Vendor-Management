const { q } = require("./db");

const shopifyConfigured = () => Boolean(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ADMIN_ACCESS_TOKEN);

async function graph(query, variables) {
  if (!shopifyConfigured()) throw new Error("Shopify Admin API credentials are not configured in Render.");
  const domain = process.env.SHOPIFY_STORE_DOMAIN.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  const version = process.env.SHOPIFY_API_VERSION || "2025-10";
  const response = await fetch("https://" + domain + "/admin/api/" + version + "/graphql.json", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_ACCESS_TOKEN },
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

    const variant = result.product.variants?.nodes?.[0];
    if (variant?.id) {
      const updated = await graph(
        "mutation UpdateMarketplaceVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {" +
        " productVariantsBulkUpdate(productId: $productId, variants: $variants) {" +
        " productVariants { id } userErrors { field message } } }",
        { productId, variants: [{
          id: variant.id,
          price: (Number(p.price_cents) / 100).toFixed(2),
          inventoryItem: { sku: p.sku || ("WAM-" + p.id), tracked: true }
        }] }
      );
      const errors = updated.productVariantsBulkUpdate.userErrors || [];
      if (errors.length) throw new Error(errors.map(x => x.message).join("; "));
    }
  }

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
  await q("update seller_product_submissions set shopify_published_at=now(), shopify_sync_error=null, updated_at=now() where id=$1", [id]);
  return { productId };
}

module.exports = { publishApprovedSubmission, shopifyConfigured };
