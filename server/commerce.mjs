// OWNER: Rucha (see docs/TEAM-PLAN.md). Commerce API routes, mounted by server/index.mjs.
// Add routes here freely; index.mjs never needs to change for commerce work.
import { ProviderError } from "./gemini.mjs";
import { checkoutLinks, findOrder, productById } from "./shopify.mjs";

export function commerceRoutes({ body }) {
  return {
    "POST /api/product": async req => {
      const { productId } = await body(req, 10_000);
      return productById(String(productId));
    },
    "POST /api/checkout": async req => {
      const { items } = await body(req, 50_000);
      if (!Array.isArray(items) || !items.length) throw new ProviderError(400, "The cart is empty.");
      return { checkouts: await checkoutLinks(items.slice(0, 20)) };
    },
    // After the shopper confirms: poll for the real order. Only dev-store checkouts carry a `ref`.
    "POST /api/order-status": async req => {
      const { checkout } = await body(req, 10_000);
      if (!checkout?.ref) return { status: "external" };
      return findOrder(String(checkout.ref));
    },
  };
}
