// Real Shopify storefronts: federated product search, product detail, and cart permalinks.
// Uses each store's public Storefront endpoints, so no merchant keys are needed for discovery.
// Checkout is a Shopify cart permalink: the shopper reviews and pays on the store's own checkout.
import { randomBytes } from "node:crypto";
import { ProviderError } from "./gemini.mjs";

const DEFAULT_STORES = "www.albanypark.com,www.burrow.com,www.walkeredison.com,www.tribesigns.com,floydhome.com,www.schoolhouse.com";
const API_VERSION = () => process.env.SHOPIFY_API_VERSION || "2025-10";
const cleanHost = h => String(h || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

// The team's Shopify development store (test payments). Empty when not configured.
export const devHost = () => cleanHost(process.env.SHOPIFY_DEV_STORE);
const isDev = host => Boolean(devHost()) && host === devHost();

// Public stores for discovery, plus the dev store (always searched when configured).
export const stores = () => {
  const list = (process.env.SHOPIFY_STORES || DEFAULT_STORES).split(",").map(cleanHost).filter(Boolean);
  const dev = devHost();
  return dev && !list.includes(dev) ? [dev, ...list] : list;
};

const cache = new Map();
const UA = { "User-Agent": "Mozilla/5.0 (SpaceTheory hackathon demo)", Accept: "application/json" };

const NAMES = { "www.albanypark.com": "Albany Park", "www.burrow.com": "Burrow", "floydhome.com": "Floyd", "www.schoolhouse.com": "Schoolhouse", "www.walkeredison.com": "Walker Edison", "www.tribesigns.com": "Tribesigns" };
const storeName = host => NAMES[host] ?? (isDev(host) ? process.env.SHOPIFY_DEV_STORE_NAME || "Space Theory Store" : null) ?? host.replace(/^www\./, "").replace(/\.(com|co)$/, "").replace(/^\w/, c => c.toUpperCase());
const strip = html => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ")
  .replace(/&amp;/g, "&").replace(/&quot;|&#34;|&rdquo;|&ldquo;|&#8221;/g, '"').replace(/\s+/g, " ").trim();
const abs = url => (url?.startsWith("//") ? "https:" + url : url);

// "General Dimensions: 108.5"W x 33"H x 62"D", "21" L x 7" D", "W 80 x D 35 x H 30 in" → centimetres.
export function parseListingDims(text) {
  const t = String(text || "").replace(/[”″]/g, '"').replace(/’’/g, '"');
  const re = /(\d+(?:\.\d+)?)\s*(?:"|in(?:ches)?\.?|cm)?\s*([WLDH])\b(?:\s*[x×,]\s*(\d+(?:\.\d+)?)\s*(?:"|in(?:ches)?\.?|cm)?\s*([WLDH])\b)(?:\s*[x×,]\s*(\d+(?:\.\d+)?)\s*(?:"|in(?:ches)?\.?|cm)?\s*([WLDH])\b)?/i;
  const m = t.match(re);
  if (!m) return null;
  const unit = /cm/i.test(m[0]) ? 1 : 2.54;
  const dims = {};
  for (const [v, k] of [[m[1], m[2]], [m[3], m[4]], [m[5], m[6]]]) {
    if (!v || !k) continue;
    const key = { W: "w", L: "w", D: "d", H: "h" }[k.toUpperCase()];
    if (key && dims[key] == null) dims[key] = Math.round(Number(v) * unit * 10) / 10;
  }
  return Object.keys(dims).length >= 2 ? { ...dims, raw: m[0], source: "listing text" } : null;
}

// ---- Dev store: Storefront API (catalog + real carts) and Admin API (order status) ----
async function shopifyGraphql(kind, query, variables) {
  const host = devHost();
  const token = kind === "admin" ? process.env.SHOPIFY_ADMIN_TOKEN : process.env.SHOPIFY_STOREFRONT_TOKEN;
  if (!host || !token) throw new Error(`dev store ${kind} API is not configured`);
  const url = kind === "admin" ? `https://${host}/admin/api/${API_VERSION()}/graphql.json` : `https://${host}/api/${API_VERSION()}/graphql.json`;
  const headers = { "Content-Type": "application/json", [kind === "admin" ? "X-Shopify-Access-Token" : "X-Shopify-Storefront-Access-Token"]: token };
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10_000) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.errors) throw new Error(`Shopify ${kind} API ${response.status}: ${JSON.stringify(json.errors ?? "").slice(0, 200)}`);
  return json.data;
}
const numericId = gid => String(gid).split("/").pop();

// The dev store's products, reshaped like /products.json so normalize() handles them.
async function devProducts() {
  const data = await shopifyGraphql("storefront", `{ products(first: 100) { nodes { handle title productType vendor tags description
    images(first: 4) { nodes { url } } variants(first: 30) { nodes { id title availableForSale price { amount } } } } } }`);
  return data.products.nodes.map(p => ({
    handle: p.handle, title: p.title, product_type: p.productType, vendor: p.vendor, tags: p.tags.join(" "), body_html: p.description,
    images: p.images.nodes.map(i => ({ src: i.url })),
    variants: p.variants.nodes.map(v => ({ id: numericId(v.id), title: v.title, available: v.availableForSale, price: v.price.amount })),
  }));
}

async function getJson(url) {
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(9_000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

function normalize(host, p) {
  const description = strip(p.description ?? p.body_html).slice(0, 2500);
  const cents = typeof p.price === "number" ? p.price : Math.round(Number(p.variants?.[0]?.price ?? 0) * 100);
  const product = {
    id: `${host}:${p.handle}`,
    store: host,
    storeName: storeName(host),
    handle: p.handle,
    title: p.title,
    type: p.type ?? p.product_type ?? "",
    vendor: p.vendor ?? storeName(host),
    url: `https://${host}/products/${p.handle}`,
    price: cents / 100,
    image: abs(p.featured_image ?? p.images?.[0]?.src ?? p.images?.[0]),
    images: (p.images ?? []).slice(0, 4).map(i => abs(typeof i === "string" ? i : i.src)),
    variants: (p.variants ?? []).slice(0, 30).map(v => ({
      id: v.id, title: v.title, available: v.available !== false,
      price: typeof v.price === "number" ? v.price / 100 : Number(v.price),
    })),
    description,
    listingDims: parseListingDims(description),
  };
  cache.set(product.id, product);
  return product;
}

export async function productById(id) {
  if (cache.has(id)) return cache.get(id);
  const [host, handle] = String(id).split(":");
  if (!stores().includes(host) || !/^[a-z0-9-]+$/i.test(handle ?? "")) throw new ProviderError(404, "That product is not in the catalog.");
  const known = (await catalog(host).catch(() => new Map())).get(handle);
  return normalize(host, known ?? await getJson(`https://${host}/products/${handle}.js`));
}

// One catalog request per store, cached for 15 minutes, so search never hammers a storefront.
const catalogs = new Map();
async function catalog(host) {
  const hit = catalogs.get(host);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.products;
  const pending = (async () => {
    let raw = isDev(host) && process.env.SHOPIFY_STOREFRONT_TOKEN ? await devProducts().catch(err => { console.warn("[shopify]", err.message); return []; }) : [];
    if (!raw.length) {
      const pages = await Promise.allSettled([1, 2].map(page => getJson(`https://${host}/products.json?limit=250&page=${page}`)));
      raw = pages.flatMap(r => (r.status === "fulfilled" ? r.value.products ?? [] : []));
    }
    if (!raw.length) throw new Error(`no catalog for ${host}`);
    return new Map(raw.map(p => [p.handle, p]));
  })();
  catalogs.set(host, { at: Date.now(), products: pending });
  pending.catch(() => catalogs.delete(host));
  return pending;
}

// Whole normalized catalog of any public Shopify store (used by the eval to sample unseen products).
export async function catalogProducts(host) {
  return [...(await catalog(host)).values()].map(p => normalize(host, p));
}

const words = q => q.toLowerCase().split(/\W+/).filter(w => w.length > 2).map(w => w.replace(/s$/, ""));

async function searchStore(host, query, perStore) {
  const products = await catalog(host).catch(() => new Map());
  if (isDev(host)) {
    // Small private catalog: match any word in the query, best match first.
    const want = words(query);
    const scored = [...products.values()].map(p => ({ p, score: want.filter(w => `${p.title} ${p.product_type} ${p.tags}`.toLowerCase().includes(w)).length }))
      .filter(x => x.score > 0 || !want.length).sort((a, b) => b.score - a.score).slice(0, perStore);
    return scored.map(x => normalize(host, x.p)).filter(p => p.price > 0);
  }
  const url = `https://${host}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=${perStore}&resources[options][unavailable_products]=hide`;
  let handles = [];
  try {
    handles = ((await getJson(url)).resources?.results?.products ?? []).map(hit => hit.handle);
  } catch {
    // Store search is down or throttled: fall back to matching the cached catalog ourselves.
    const want = words(query);
    handles = [...products.values()].filter(p => want.every(w => `${p.title} ${p.product_type} ${p.tags}`.toLowerCase().includes(w)))
      .slice(0, perStore).map(p => p.handle);
  }
  const detailed = await Promise.allSettled(handles.map(async handle => products.get(handle)
    ?? getJson(`https://${host}/products/${handle}.js`)));
  return detailed.filter(r => r.status === "fulfilled").map(r => normalize(host, r.value))
    .filter(p => !/swatch|sample|gift card|assembly|service/i.test(`${p.title} ${p.type}`) && p.price > 0);
}

// Searches every store at once and merges the results.
export async function searchProducts(query, { perStore = 4, maxPrice } = {}) {
  const settled = await Promise.allSettled(stores().map(host => searchStore(host, query, perStore)));
  const products = settled.flatMap(r => (r.status === "fulfilled" ? r.value : []));
  return maxPrice ? products.filter(p => p.price <= maxPrice) : products;
}

// Real Storefront API cart on the dev store: returns the hosted checkout URL plus a reference we can find the order by.
async function devCart(entry) {
  const ref = "st-" + randomBytes(6).toString("hex");
  const data = await shopifyGraphql("storefront", `mutation($input: CartInput!) { cartCreate(input: $input) {
      cart { id checkoutUrl } userErrors { field message } } }`, {
    input: {
      lines: entry.lines.map(l => ({ merchandiseId: `gid://shopify/ProductVariant/${l.variantId}`, quantity: l.quantity })),
      attributes: [{ key: "space_theory_ref", value: ref }],
      note: `Space Theory order ${ref}`,
    },
  });
  const { cart, userErrors } = data.cartCreate;
  if (!cart?.checkoutUrl || userErrors?.length) throw new Error(`cartCreate failed: ${JSON.stringify(userErrors)}`);
  return { url: cart.checkoutUrl, cartId: cart.id, ref };
}

// One checkout per store. Dev store → real Storefront cart (test payment). Public stores → cart permalink
// (https://store/cart/VARIANT:QTY,...) where the shopper pays on the merchant's own checkout.
export async function checkoutLinks(items) {
  const byStore = new Map();
  for (const item of items) {
    const product = await productById(item.productId);
    const variant = product.variants.find(v => String(v.id) === String(item.variantId))
      ?? product.variants.find(v => v.available) ?? product.variants[0];
    if (!variant) continue;
    const quantity = Math.max(1, Math.min(10, Number(item.quantity) || 1));
    const entry = byStore.get(product.store) ?? { store: product.store, storeName: product.storeName, lines: [], total: 0 };
    entry.lines.push({ title: product.title, variant: variant.title, quantity, price: variant.price, variantId: variant.id });
    entry.total += variant.price * quantity;
    byStore.set(product.store, entry);
  }
  return Promise.all([...byStore.values()].map(async entry => {
    const out = { ...entry, total: Math.round(entry.total * 100) / 100,
      url: `https://${entry.store}/cart/${entry.lines.map(l => `${l.variantId}:${l.quantity}`).join(",")}` };
    if (isDev(entry.store) && process.env.SHOPIFY_STOREFRONT_TOKEN) {
      try { Object.assign(out, await devCart(entry), { status: "pending", test: true }); }
      catch (err) { console.warn("[shopify] dev cart failed, using cart link:", err.message); }
    }
    return out;
  }));
}

// Finds the dev-store order created from a checkout (matched by the reference we put on the cart).
export async function findOrder(ref) {
  if (!/^st-[a-f0-9]{12}$/.test(String(ref))) throw new ProviderError(400, "Unknown order reference.");
  let data;
  try {
    data = await shopifyGraphql("admin", `{ orders(first: 25, sortKey: CREATED_AT, reverse: true) { nodes {
      name note displayFinancialStatus currentTotalPriceSet { shopMoney { amount } } customAttributes { key value } } } }`);
  } catch (err) {
    throw new ProviderError(501, `Order status unavailable: ${err.message}`);
  }
  const hit = data.orders.nodes.find(o => o.customAttributes?.some(a => a.key === "space_theory_ref" && a.value === ref) || (o.note ?? "").includes(ref));
  if (!hit) return { status: "pending" };
  const paid = ["PAID", "AUTHORIZED", "PARTIALLY_PAID"].includes(hit.displayFinancialStatus);
  return { status: paid ? "paid" : "pending", orderName: hit.name, total: Number(hit.currentTotalPriceSet?.shopMoney?.amount) };
}
