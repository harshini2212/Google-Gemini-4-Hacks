// OWNER: Rucha (see docs/TEAM-PLAN.md). Browser-side commerce calls used by the designer's tools.
// main.jsx only calls these three functions, so everything behind them is yours to change.

async function post(path, payload) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Commerce request failed.");
  return data;
}

// add_to_cart tool → returns the CartItem to put in the cart.
export async function makeCartItem(product, quantity = 1) {
  const full = product?.variants ? product : await post("/api/product", { productId: product.id ?? product });
  const variant = full.variants.find(v => v.available) ?? full.variants[0];
  return { productId: full.id, variantId: variant?.id, title: full.title, price: variant?.price ?? full.price, quantity: Math.max(1, Number(quantity) || 1), variantTitle: variant?.title };
}

// checkout tool → returns { checkouts: Checkout[] } (see docs/TEAM-PLAN.md for the shape).
export async function startCheckout(items) {
  return post("/api/checkout", { items });
}

// Poll after the shopper confirms, to show "Order #1001 placed" in the app (dev-store checkouts only).
export async function orderStatus(checkout) {
  return post("/api/order-status", { checkout });
}
