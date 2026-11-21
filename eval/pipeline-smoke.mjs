// End-to-end smoke test of the real pipeline (search -> specs -> rank -> 3D build). Run: node --env-file=.env eval/pipeline-smoke.mjs [query]
import { searchProducts } from "../server/shopify.mjs";
import { buildModel, fillSpecs, rankProducts } from "../server/home.mjs";
import { recentTrace } from "../server/gemini.mjs";

const query = process.argv[2] || "accent chair";
let t = Date.now();
const found = await searchProducts(query);
console.log(`search: ${found.length} products in ${Date.now() - t}ms`);
t = Date.now();
await fillSpecs(found.slice(0, 16));
const ranked = await rankProducts({ products: found.slice(0, 16), request: query, room: { style: "Scandinavian", room_type: "living room", palette: ["white", "oak"] }, space: { width_cm: 120 } });
console.log(`specs+rank: ${Date.now() - t}ms`);
for (const p of ranked.slice(0, 6)) console.log(`  ${p.score}  ${p.title} (${p.storeName}) fit=${p.fit.fits} ${p.listingDims ? Math.round(p.listingDims.w) + "w " + (p.listingDims.source || "") : ""} · ${p.reason}`);
t = Date.now();
const built = await buildModel(ranked[0].id);
console.log(`3D build: ${Date.now() - t}ms · ${built.model.parts.length} parts`);
for (const s of built.steps) console.log(`  ${s.step}: ${s.detail.slice(0, 160)}`);
console.log("final check:", built.checks.final.ok, built.checks.final.issues);
console.log(recentTrace().map(x => `${x.role}:${x.ok ? "ok" : "FAIL"}:${x.ms}ms`).join(" "));
