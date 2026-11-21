// Real Shopify storefronts: federated product search, product detail, and cart permalinks.
// Uses each store's public Storefront endpoints, so no merchant keys are needed for discovery.
// Checkout is a Shopify cart permalink: the shopper reviews and pays on the store's own checkout.
import { ProviderError } from "./gemini.mjs";

const DEFAULT_STORES = "www.albanypark.com,www.burrow.com,www.walkeredison.com,www.tribesigns.com,floydhome.com,www.schoolhouse.com";
export const stores = () => (process.env.SHOPIFY_STORES || DEFAULT_STORES).split(",").map(s => s.trim()).filter(Boolean);

const cache = new Map();
const UA = { "User-Agent": "Mozilla/5.0 (SpaceTheory hackathon demo)", Accept: "application/json" };

const NAMES = { "www.albanypark.com": "Albany Park", "www.burrow.com": "Burrow", "floydhome.com": "Floyd", "www.schoolhouse.com": "Schoolhouse", "www.walkeredison.com": "Walker Edison", "www.tribesigns.com": "Tribesigns" };
const storeName = host => NAMES[host] ?? host.replace(/^www\./, "").replace(/\.(com|co)$/, "").replace(/^\w/, c => c.toUpperCase());
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
    const pages = await Promise.allSettled([1, 2].map(page => getJson(`https://${host}/products.json?limit=250&page=${page}`)));
    const raw = pages.flatMap(r => (r.status === "fulfilled" ? r.value.products ?? [] : []));
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

// One Shopify cart permalink per store: https://store/cart/VARIANT:QTY,VARIANT:QTY
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
  return [...byStore.values()].map(entry => ({
    ...entry,
    total: Math.round(entry.total * 100) / 100,
    url: `https://${entry.store}/cart/${entry.lines.map(l => `${l.variantId}:${l.quantity}`).join(",")}`,
  }));
}
