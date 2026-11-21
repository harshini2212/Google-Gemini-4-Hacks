// Space Theory eval: does the 3D pipeline build products at their true size, on products we never saw?
//
// Test set: a seeded random sample of real products from public Shopify stores whose listing states
// overall W x D x H. Those listed numbers are the ground truth. Nobody on the team picked or edited them.
//
// Two conditions:
//   A "full listing"  - photos + title + the listing text (as a shopper would paste a product link)
//   B "photo only"    - photos + title; every dimension is scrubbed from the text (an Instagram post, a
//                       screenshot, a showroom photo). This is the messy, hard case.
// Two systems:
//   baseline  - one call to the same reasoning model: "build this product in 3D" (no dimension step, no checks)
//   pipeline  - Theo: dimension extraction -> draft -> rule checks -> up to 2 repairs -> snap to measured size
//
// Usage:  node --env-file=.env eval/run.mjs [--n 20] [--conditions A,B] [--seed 7] [--collect-only]
import { mkdir, writeFile } from "node:fs/promises";
import { catalogProducts, parseListingDims } from "../server/shopify.mjs";
import { baselineModel, boundsOf, buildModelFor, checkModel } from "../server/home.mjs";
import { MODELS } from "../server/gemini.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const N = Number(arg("n", 20));
const SEED = Number(arg("seed", 7));
const CONDITIONS = arg("conditions", "A,B").split(",");
const CONCURRENCY = Number(arg("concurrency", 4));
const EVAL_STORES = (process.env.EVAL_STORES || "www.tribesigns.com,www.walkeredison.com,www.albanypark.com,www.burrow.com")
  .split(",").map(s => s.trim());

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

async function collect() {
  const all = [];
  for (const host of EVAL_STORES) {
    try {
      const products = await catalogProducts(host);
      const usable = products.filter(p => p.listingDims?.w && p.listingDims?.d && p.listingDims?.h && p.image
        && !/swatch|sample|pillow cover|gift|fabric by|replacement|hardware|strap/i.test(p.title)
        && p.listingDims.w > 15 && p.listingDims.h > 15);
      console.log(`${host}: ${products.length} products, ${usable.length} with full W×D×H`);
      all.push(...usable);
    } catch (error) {
      console.log(`${host}: skipped (${error.message})`);
    }
  }
  const random = rng(SEED);
  const shuffled = all.map(p => [random(), p]).sort((a, b) => a[0] - b[0]).map(([, p]) => p);
  // Cap each store so one catalog doesn't dominate.
  const perStore = new Map();
  return shuffled.filter(p => {
    const n = perStore.get(p.store) ?? 0;
    if (n >= Math.max(8, Math.ceil(N / 2))) return false;
    perStore.set(p.store, n + 1);
    return true;
  }).slice(0, N);
}

const DIM_TEXT = /(\d+(\.\d+)?\s*("|”|″|in\b|inch(es)?|cm|mm|ft|')\s*[WLDH]?\b)|(\b[WLDH]\s*:?\s*\d+(\.\d+)?)|dimensions?[^.]*\.?/gi;
function forCondition(product, condition) {
  if (condition === "A") return product;
  return { ...product, description: product.description.replace(DIM_TEXT, " ").replace(/\s+/g, " "), listingDims: null };
}

function score(model, truth) {
  if (!model?.parts?.length) return { valid: false, err: { w: 1, d: 1, h: 1 }, mape: 1, within10: false };
  const check = checkModel(model, null);
  let size;
  try { size = boundsOf(model).size; } catch { return { valid: false, err: { w: 1, d: 1, h: 1 }, mape: 1, within10: false }; }
  const err = Object.fromEntries(["w", "d", "h"].map(k => [k, Math.abs(size[k] - truth[k]) / truth[k]]));
  const mape = (err.w + err.d + err.h) / 3;
  return { valid: check.ok, issues: check.issues, size, err, mape, within10: Object.values(err).every(e => e <= 0.1) };
}

async function pool(items, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

const pct = v => `${(v * 100).toFixed(1)}%`;
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

const testSet = await collect();
console.log(`\nTest set: ${testSet.length} products from ${new Set(testSet.map(p => p.store)).size} stores (seed ${SEED})`);
if (process.argv.includes("--collect-only")) {
  for (const p of testSet) console.log(`- ${p.storeName}: ${p.title} · ${p.listingDims.w}×${p.listingDims.d}×${p.listingDims.h} cm · "${p.listingDims.raw}"`);
  process.exit(0);
}

const jobs = CONDITIONS.flatMap(condition => testSet.flatMap(product => ["baseline", "pipeline"].map(system => ({ condition, system, product }))));
console.log(`Running ${jobs.length} builds with builder ${MODELS.carbon()} + dimensions ${MODELS.neon()} (concurrency ${CONCURRENCY})…\n`);

const results = await pool(jobs, async ({ condition, system, product }, i) => {
  const truth = product.listingDims;
  const input = forCondition(product, condition);
  const started = Date.now();
  try {
    if (system === "baseline") {
      const model = await baselineModel(input);
      const s = score(model, truth);
      console.log(`[${i + 1}/${jobs.length}] ${condition} baseline  ${pct(s.mape).padStart(7)}  ${product.title}`);
      return { condition, system, id: product.id, title: product.title, truth, ...s, ms: Date.now() - started };
    }
    const built = await buildModelFor(input);
    const s = score(built.model, truth);
    console.log(`[${i + 1}/${jobs.length}] ${condition} pipeline  ${pct(s.mape).padStart(7)}  ${product.title}  (repairs ${built.steps.filter(x => x.step.startsWith("repair")).length})`);
    return {
      condition, system, id: product.id, title: product.title, truth, ...s, ms: Date.now() - started,
      extracted: { w: built.dims.w, d: built.dims.d, h: built.dims.h, source: built.dims.source },
      firstDraftPassed: built.checks.first.ok, repairs: built.steps.filter(x => x.step.startsWith("repair")).length,
      issuesBeforeRepair: built.checks.first.issues,
    };
  } catch (error) {
    console.log(`[${i + 1}/${jobs.length}] ${condition} ${system} ERROR ${error.message}`);
    return { condition, system, id: product.id, title: product.title, truth, valid: false, mape: 1, within10: false, error: error.message, ms: Date.now() - started };
  }
});

const rows = [];
for (const condition of CONDITIONS) {
  for (const system of ["baseline", "pipeline"]) {
    const r = results.filter(x => x.condition === condition && x.system === system);
    rows.push({
      condition, system, n: r.length,
      mape: mean(r.map(x => x.mape)), median: median(r.map(x => x.mape)),
      within10: mean(r.map(x => (x.within10 ? 1 : 0))), valid: mean(r.map(x => (x.valid ? 1 : 0))),
      errors: r.filter(x => x.error).length, seconds: mean(r.map(x => x.ms)) / 1000,
    });
  }
}

const label = { A: "A · full listing", B: "B · photo only (dims scrubbed)" };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const worst = results.filter(r => r.system === "pipeline").sort((a, b) => b.mape - a.mape).slice(0, 6);
const report = `# Space Theory eval: true-size 3D from real Shopify products

Run ${new Date().toISOString()} · 3D builder \`${MODELS.carbon()}\`, dimensions \`${MODELS.neon()}\` · ${testSet.length} unseen products from ${new Set(testSet.map(p => p.store)).size} Shopify stores (seed ${SEED}).
Ground truth is the overall W × D × H printed in each listing. Error is the model's bounding box vs that truth, averaged over the three axes.

| Condition | System | n | Mean size error | Median | All 3 axes within 10% | Passes structure checks | Avg time |
|---|---|---|---|---|---|---|---|
${rows.map(r => `| ${label[r.condition]} | ${r.system} | ${r.n} | ${pct(r.mape)} | ${pct(r.median)} | ${pct(r.within10)} | ${pct(r.valid)} | ${r.seconds.toFixed(1)}s |`).join("\n")}

Pipeline drafts that passed every check on the first try: ${pct(mean(results.filter(r => r.system === "pipeline" && !r.error).map(r => (r.firstDraftPassed ? 1 : 0))))}; average repairs per product: ${mean(results.filter(r => r.system === "pipeline" && !r.error).map(r => r.repairs)).toFixed(2)}.

## Where the pipeline still fails (worst ${worst.length})

${worst.map(r => `- **${r.title}** (${label[r.condition]}): ${pct(r.mape)} off. Truth ${r.truth.w}×${r.truth.d}×${r.truth.h} cm; Theo used ${r.extracted ? `${r.extracted.w}×${r.extracted.d}×${r.extracted.h} cm (${String(r.extracted.source).slice(0, 120)})` : "n/a"}${r.error ? ` · error: ${r.error}` : ""}`).join("\n")}

Raw results: \`eval/results/${stamp}.json\`
`;

await mkdir(new URL("./results/", import.meta.url), { recursive: true });
await writeFile(new URL(`./results/${stamp}.json`, import.meta.url), JSON.stringify({ rows, results }, null, 2));
await writeFile(new URL("./REPORT.md", import.meta.url), report);
console.log("\n" + report);
