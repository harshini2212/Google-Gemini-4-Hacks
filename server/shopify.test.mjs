// Offline tests for the Shopify part (mocked fetch). Run: node server/shopify.test.mjs
import assert from "node:assert/strict";
process.env.SHOPIFY_DEV_STORE = "demo.myshopify.com";
process.env.SHOPIFY_STOREFRONT_TOKEN = "sf";
process.env.SHOPIFY_ADMIN_TOKEN = "ad";
process.env.SHOPIFY_STORES = "www.example.com";
const { stores, searchProducts, checkoutLinks, findOrder } = await import("./shopify.mjs");

let order = null;
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ url: String(url), body });
  const ok = data => ({ ok: true, status: 200, json: async () => data });
  if (String(url).includes("/api/") && /products\(first/.test(body.query)) return ok({ data: { products: { nodes: [{
    handle: "oslo-sofa", title: "Oslo Sofa", productType: "Sofa", vendor: "Demo", tags: ["sofa"], description: '86"W x 32"H x 37.5"D',
    images: { nodes: [{ url: "https://cdn/x.jpg" }] }, variants: { nodes: [{ id: "gid://shopify/ProductVariant/111", title: "Default Title", availableForSale: true, price: { amount: "1499.00" } }] } }] } } });
  if (/cartCreate/.test(body.query)) { order = body.variables.input.attributes[0].value;
    return ok({ data: { cartCreate: { cart: { id: "gid://shopify/Cart/1", checkoutUrl: "https://demo.myshopify.com/cart/c/1" }, userErrors: [] } } }); }
  if (String(url).includes("/admin/")) return ok({ data: { orders: { nodes: order ? [{ name: "#1001", note: "", displayFinancialStatus: "PAID",
    currentTotalPriceSet: { shopMoney: { amount: "1499.00" } }, customAttributes: [{ key: "space_theory_ref", value: order }] }] : [] } } });
  throw new Error("unexpected fetch " + url);
};

assert.deepEqual(stores(), ["demo.myshopify.com", "www.example.com"]);
const found = (await searchProducts("sofa")).filter(p => p.store === "demo.myshopify.com");
assert.equal(found.length, 1);
assert.equal(found[0].price, 1499);
assert.equal(found[0].variants[0].id, "111");
assert.ok(found[0].listingDims?.w > 200, "dims parsed from the listing");

const [checkout] = await checkoutLinks([{ productId: found[0].id, variantId: "111", quantity: 2 }]);
assert.equal(checkout.url, "https://demo.myshopify.com/cart/c/1");
assert.equal(checkout.total, 2998);
assert.equal(checkout.test, true);
assert.match(checkout.ref, /^st-[a-f0-9]{12}$/);
const cartCall = calls.find(c => /cartCreate/.test(c.body.query));
assert.equal(cartCall.body.variables.input.lines[0].merchandiseId, "gid://shopify/ProductVariant/111");

assert.deepEqual(await findOrder(checkout.ref), { status: "paid", orderName: "#1001", total: 1499 });
order = null;
assert.deepEqual(await findOrder(checkout.ref), { status: "pending" });
await assert.rejects(() => findOrder("not-a-ref"), /Unknown order reference/);
console.log("shopify: all tests passed");
