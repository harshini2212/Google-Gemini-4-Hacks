// Offline tests for the rule checks and snap-to-size (no API calls). Run: node eval/checks.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { boundsOf, checkModel, fitCheck, snapToDims } from "../server/home.mjs";
import { parseListingDims } from "../server/shopify.mjs";

const sofa = JSON.parse(await readFile(new URL("./fixtures/sofa-model.json", import.meta.url)));
const size = boundsOf(sofa).size;
console.log("fixture size", size);

const good = checkModel(sofa, { w: size.w, d: size.d, h: size.h });
assert.equal(good.ok, true, good.issues.join(" "));

const tooWide = checkModel(sofa, { w: size.w * 0.7, d: size.d, h: size.h });
assert.equal(tooWide.ok, false);
assert.match(tooWide.issues.join(" "), /width/);

const floating = { ...sofa, parts: [...sofa.parts, { ...sofa.parts[0], name: "lost cushion", center_cm: [0, 150, 0] }] };
assert.match(checkModel(floating, null).issues.join(" "), /Floating parts.*lost cushion/);

const lifted = { ...sofa, parts: sofa.parts.map(p => ({ ...p, center_cm: [p.center_cm[0], p.center_cm[1] + 10, p.center_cm[2]] })) };
assert.match(checkModel(lifted, null).issues.join(" "), /floor/);

const snapped = snapToDims(lifted, { w: 230, d: 95, h: 82 });
const s2 = boundsOf(snapped);
assert.ok(Math.abs(s2.size.w - 230) < 0.01 && Math.abs(s2.size.d - 95) < 0.5 && Math.abs(s2.size.h - 82) < 0.5, JSON.stringify(s2.size));
assert.ok(Math.abs(s2.min[1]) < 0.01);

assert.deepEqual(parseListingDims('General Dimensions: 108.5"W x 33"H x 62"D Seat Height').w, 275.6);
assert.equal(parseListingDims('59.06"W x 13.78"D x 21.65"H').h, 55);
assert.equal(parseListingDims("no numbers here"), null);

assert.equal(fitCheck({ w: 200 }, { width_cm: 220 }).fits, "yes");
assert.equal(fitCheck({ w: 240 }, { width_cm: 220 }).fits, "no");
assert.equal(fitCheck(null, { width_cm: 220 }).fits, "unknown");
console.log("all checks passed");
