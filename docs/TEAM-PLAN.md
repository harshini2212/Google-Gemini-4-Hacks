# Space Theory: team plan and PRD (2 builders, deadline 5:00 PM)

**One-line pitch.** On a live video call, you point your phone at your room and the designer finds real furniture that fits, builds each piece in 3D at true size over your camera, places it in your room, and buys it through Shopify once you confirm.

**Demo story (3 min, judged live):**
1. *(0:00)* Open Space Theory on the phone (or laptop camera), tap **Start call**, and point it at an empty wall. "I need a sofa for this wall, under $1,800." Decision 1 gates the frame, then Neon reads the room and estimates the open wall at about 220 cm.
2. *(0:30)* Product cards from real Shopify stores, each with a fit badge. Hydrogen workers read the specs in parallel, Decision 1 ranks the cards, and fit is computed in code.
3. *(0:50)* "Show me the first one in 3D." Carbon builds the measured part model, the rule checks and repair loop run, and the model appears over the live camera at true size. Decision 1 scores the render against the photo, and Neon + Carbon repair it if the score is low.
4. *(1:40)* "Put it in my room." Nano Banana draws it into the actual camera frame.
5. *(2:10)* "I'll take it." → add to cart → "Checkout." **A real Shopify order is placed** (dev store, test payment) after the shopper taps Confirm, and an order number appears on screen.
6. *(2:40)* Show the eval table in `eval/REPORT.md`: pipeline vs baseline on 30 unseen products.

---

## Who owns what (no shared files = no merge conflicts)

| Area | Owner | Files (only the owner edits them) |
| --- | --- | --- |
| Live call (voice + camera), 3D generator, room reading, ranking, image placement, eval, UI shell | **Harshini** | `src/main.jsx`, `src/live.mjs`, `src/model-view.jsx`, `src/app.css`, `server/gemini.mjs`, `server/home.mjs`, `server/index.mjs`, `shared/home-tools.mjs`, `eval/*`, `README.md` |
| Shopify catalog, cart, checkout, **real transactions**, order status | **Rucha (Shopify)** | `server/shopify.mjs`, `server/commerce.mjs`, `src/commerce/cart.jsx`, `src/commerce/client.mjs`, `src/commerce/commerce.css`, `docs/SHOPIFY.md` (new) |

Rules:
- Edit only your own files. Harshini and Rucha message each other for any change in the other person's files.
- Never commit `.env`. Share keys out of band.
- Commit small and often to `main`, and pull before you push (`git pull --rebase`). Each of you only touches your own files, so rebases stay clean.
- Commit messages start with your area: `live: …`, `3d: …`, `shop: …`.

---

## The contract between us (do not change without telling the other person)

### Product (returned by `searchProducts`, `productById`)
```js
{
  id: "www.albanypark.com:barton-sofa",   // "<store host>:<handle>", stable, used everywhere
  store: "www.albanypark.com", storeName: "Albany Park",
  handle, title, type, vendor, url,
  price: 1688,                             // USD number
  image: "https://cdn.shopify.com/...",    // main photo (absolute URL)
  images: [url, ...],                      // up to 4
  variants: [{ id, title, price, available }],
  description: "plain text, ≤2500 chars",
  listingDims: { w, d, h, raw, source } | null   // centimetres, parsed from the listing
}
```

### Functions in `server/shopify.mjs` that Harshini's code calls
| Function | Used by | Must return |
| --- | --- | --- |
| `searchProducts(query, { perStore, maxPrice })` | `/api/products` → ranking | `Product[]` |
| `productById(id)` | 3D builder, staging, eval | `Product` |
| `catalogProducts(host)` | eval only | `Product[]` |
| `parseListingDims(text)` | eval + tests | `{w,d,h,raw}` or `null` |
| `stores()` | status | `string[]` |

### Browser functions in `src/commerce/client.mjs` that `main.jsx` calls
| Function | When | Must return |
| --- | --- | --- |
| `makeCartItem(productOrId, quantity)` | `add_to_cart` tool | `{ productId, variantId, title, price, quantity, variantTitle }` |
| `startCheckout(items)` | `checkout` tool | `{ checkouts: Checkout[] }` |
| `orderStatus(checkout)` | optional, after payment | `{ status: "pending" \| "paid", orderName? }` |

### Checkout (what `/api/checkout` returns, rendered by `src/commerce/cart.jsx`)
```js
{ store, storeName, lines: [{ title, variant, quantity, price, variantId }], total, url, // url = where the shopper confirms and pays
  // new fields for real transactions (add them, the UI is yours):
  cartId?, orderName?, status? }
```

### Props of `<CartBar>` (rendered by `main.jsx`)
`cart, setCart, checkouts, setCheckouts, run` (call `run("checkout", {})` to start checkout). Add any UI you want inside it.

---

## Rucha: what to build, in order (Shopify + transactions)

**Goal: a real transaction on stage, with the shopper in control.** The guide's rule is "keep people in control whenever an action affects money", so the designer never pays by herself. The shopper always taps a Confirm or Pay button.

1. **Account + dev store (first 15 min).** Use [shop.dev](https://shop.dev) or ask the onsite Shopify Solutions Engineers to create a **development store**. Enable test payments (Shopify's Bogus Gateway or Shopify Payments test mode). Create a Storefront API token and an Admin API token. Put them in `.env` as `SHOPIFY_DEV_STORE`, `SHOPIFY_STOREFRONT_TOKEN` and `SHOPIFY_ADMIN_TOKEN`, and never commit them.
2. **Seed the dev store with real products (30 min).** Import 10–15 products for the demo (2–3 sofas, chairs, a lamp, a side table). Copy title, price, photos and the **W × D × H in the description** in the form `86"W x 32"H x 37.5"D` so `parseListingDims` reads them. Add the dev store to `SHOPIFY_STORES` so search covers it.
3. **Real cart + checkout (45 min).** In `server/shopify.mjs`, rewrite `checkoutLinks(items)`. For dev-store items, call the Storefront API `cartCreate` with the lines and return its `checkoutUrl` as `url`, plus `cartId`. Keep the cart-permalink path for the public stores as a fallback.
4. **Confirm step (20 min).** In `src/commerce/cart.jsx`, show a clear review sheet (items, total, store) with **Confirm & pay**. It opens `checkoutUrl` in a new tab where the test payment completes. Only show it after the voice or chat `checkout` tool fires.
5. **Order confirmation (30 min, high wow).** Add `POST /api/order-status` in `server/commerce.mjs`. Use the Admin API to find the order created from that cart/checkout (e.g. latest order with matching line items, or a `orders/create` webhook if you have time). Poll it from `cart.jsx` every 3 s after Confirm, and show "Order #1001 placed ✓".
6. **Stretch:** a Shopify Catalog / Storefront MCP search across more merchants via shop.dev, inventory and variant pickers (colour/fabric), shipping estimate.

Test without Harshini's code: `curl -X POST localhost:5180/api/checkout -H 'Content-Type: application/json' -d '{"items":[{"productId":"<id>","quantity":1}]}'`

---

## Harshini: what to build (in order)

1. **Keys + models (now).** Put the hackathon `GEMINI_API_KEY` in `.env`. Model ids are already set from the Builder Guide in `server/gemini.mjs`.
2. **Live call on the phone (45 min).** Test `Start call` on the laptop first. For the phone, run `npm run phone` and open the printed `https://<wifi-ip>:5443` address on a phone on the same Wi-Fi (accept the certificate warning).
3. **3D generator hardening (45 min).** Run `show_in_3d` on 5 products and tune `MODEL_RULES`. Make sure the AR overlay sits on the floor and the dims tag shows.
4. **Eval (runs in background, 20 min).** `node --env-file=.env eval/run.mjs --n 30`, then put the table into the README and the demo.
5. **Demo polish (last 30 min).** Rehearse the 3-minute story twice and record the 1-minute submission video.

## Gemini models, one job each (from the Builder Guide)

| Model | Id | Job in Space Theory |
| --- | --- | --- |
| Gemini 3.8 Live | `gemini-3.8-live` | Voice + camera call; decides which tool to call |
| **Gemini 4 Carbon** | `gemini-4-carbon` | Deepest reasoning: drafts and repairs the measured 3D part model |
| **Gemini 4 Neon** | `gemini-4-neon` | Fast frontier analysis while you wait: reads the room, resolves dimensions, lists render-vs-photo differences |
| **Gemini 4 Hydrogen** | `gemini-4-hydrogen` | Workhorse: typed chat agent + parallel spec-reading workers for every search result |
| Gemini Decision 1 | `gemini-decision-1` | Decisions API: gates camera frames (yes/no), ranks products (rubric), scores 3D likeness (rubric) |
| Nano Banana 2.1 | `gemini-nano-banana-2.1` | Places the product into the shopper's own camera frame |

## Timeline (today)

| Time | Harshini | Rucha |
| --- | --- | --- |
| now → 3:45 | key in, live call working, first 3D builds | dev store + tokens + seed products |
| 3:45 → 4:20 | phone camera, 3D tuning, start eval | Storefront `cartCreate` checkout + confirm sheet |
| 4:20 → 4:40 | eval table into README | order-status polling + "Order placed" |
| 4:40 → 5:00 | **together:** full demo run on real inputs, record 1-min video, submit (repo public!) | |
