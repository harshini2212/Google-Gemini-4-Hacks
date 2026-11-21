# Shopify setup (Rucha)

Search covers the public stores plus your dev store. Checkout on the dev store is a real Storefront API cart with test payments; the shopper taps **Confirm & pay**, pays with the test card, and the app polls the Admin API until it shows "Order #1001 placed ✓". Public stores still use cart links (the shopper pays on the merchant's own checkout, no order status).

## One-time setup (about 15 minutes)
1. Create a **development store** (shop.dev or the onsite Shopify team).
2. Settings → Payments: enable the **Bogus Gateway** (test mode). Test card: number `1`, any future expiry, any 3-digit CVV.
3. Settings → Apps and sales channels → **Develop apps** → create an app:
   - Storefront API scopes: `unauthenticated_read_product_listings`, `unauthenticated_read_product_inventory`, `unauthenticated_write_checkouts`, `unauthenticated_read_checkouts`
   - Admin API scope: `read_orders`
   - Install it, then copy the **Storefront access token** and the **Admin API access token**.
4. Add 10 to 15 products (sofas, chairs, a lamp, a side table). Put the size in the description like `86"W x 32"H x 37.5"D` so `parseListingDims` reads it. Make sure each product is available to the app's sales channel (if search returns nothing, check this first).
5. In `.env`:
```
SHOPIFY_DEV_STORE=your-store.myshopify.com
SHOPIFY_STOREFRONT_TOKEN=...
SHOPIFY_ADMIN_TOKEN=...
# optional: SHOPIFY_DEV_STORE_NAME=Space Theory Store   SHOPIFY_API_VERSION=2025-10
```
Never commit `.env`.

## How it works
- `server/shopify.mjs`: dev catalog via Storefront GraphQL (falls back to the public `/products.json`), `cartCreate` for the dev store (tags the cart with a `space_theory_ref`), `findOrder(ref)` via the Admin API. If the dev cart fails it falls back to a cart link, so checkout never breaks the demo.
- `server/commerce.mjs`: `POST /api/order-status` returns `{status: "pending" | "paid" | "external", orderName?}`.
- `src/commerce/cart.jsx`: review card per store, **Confirm & pay**, then polls every 3 s.

## Tests
`node server/shopify.test.mjs` (offline, mocked Shopify). Not yet run against a real store: that needs your tokens.

## Quick manual check
```
curl -X POST localhost:5180/api/checkout -H 'Content-Type: application/json' -d '{"items":[{"productId":"<id>","quantity":1}]}'
```
