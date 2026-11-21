// Space Theory's multimodal jobs: read the room, rank products for it, build a measured 3D model
// of a product from its photos and listing, check that model against the numbers and the photo,
// and draw the product into the caller's own camera frame.
import { decide, fetchImagePart, generateImage, generateJson, imagePart, MODELS, rubric01 } from "./gemini.mjs";
import { productById, searchProducts } from "./shopify.mjs";

const S = (type, extra = {}) => ({ type, ...extra });
const num = S("NUMBER");
const str = S("STRING");
const vec3 = S("ARRAY", { items: num, minItems: 3, maxItems: 3 });

// ---------- Room ----------
const roomSchema = S("OBJECT", {
  properties: {
    room_type: str,
    style: str,
    palette: S("ARRAY", { items: str }),
    existing_items: S("ARRAY", { items: str }),
    reference_used: S("STRING", { description: "Object of known size used to estimate scale, e.g. a door, outlet or chair." }),
    open_spaces: S("ARRAY", {
      items: S("OBJECT", {
        properties: {
          where: str, width_cm: num, depth_cm: num, confidence: S("STRING", { enum: ["low", "medium", "high"] }),
        },
        required: ["where", "width_cm", "depth_cm", "confidence"],
      }),
    }),
    summary: str,
  },
  required: ["room_type", "style", "palette", "existing_items", "open_spaces", "summary", "reference_used"],
});

const decisionImage = (base64, mime = "image/jpeg") => ({ type: "image", data: base64, mime_type: mime });

export async function scanRoom({ frame, goal }) {
  // Decision 1 gate (~200 ms): only spend a Neon call on frames that actually show a space.
  try {
    const answers = await decide({
      job: "gate: is the camera showing a room?",
      input: [decisionImage(frame), { type: "text", text: "A live phone-camera frame from a shopper furnishing their home." }],
      questions: { shows_space: { type: "noul", instructions: "Does this frame show part of a room, floor or outdoor space where furniture could be placed (not a close-up of a face, ceiling, screen or blurry motion)?" } },
    });
    const gate = answers.shows_space;
    if (gate && gate.noul < 0.3 && gate.confidence > 0.6) {
      return { not_a_room: true, summary: "The camera isn't showing a space I can measure. Ask the shopper to point it at the floor area they want to furnish.", open_spaces: [] };
    }
  } catch {
    // Gate unavailable: fall through to the full read.
  }
  return generateJson({
    role: "neon", job: "read the room from the camera",
    system: "You are a careful interior measurer looking through a live phone camera. Estimate sizes only from visible reference objects of known size (interior doors ~80x203 cm, outlets ~7x11 cm, standard chairs ~45 cm seat height, floor tiles, sofas ~85 cm deep). Say which reference you used. Never invent spaces you cannot see. Be conservative: round open widths down.",
    parts: [{ text: `The shopper's goal: ${goal || "furnish this space"}. Describe the room and the open floor spaces where furniture could go.` }, imagePart(frame)],
    schema: roomSchema,
  });
}

// ---------- Specs (Hydrogen subagents) ----------
const specSchema = S("OBJECT", {
  properties: {
    w: S("NUMBER", { description: "Overall width in cm, 0 if unknown." }),
    d: S("NUMBER", { description: "Overall depth in cm, 0 if unknown." }),
    h: S("NUMBER", { description: "Overall height in cm, 0 if unknown." }),
    category: str,
  },
  required: ["w", "d", "h", "category"],
});

// Parallel Hydrogen workers fill in sizes for search results whose listing has no parseable W×D×H,
// so every card can show a fit badge. Marked as estimates.
export async function fillSpecs(products, limit = 8) {
  const missing = products.filter(p => !(p.listingDims?.w && p.listingDims?.d)).slice(0, limit);
  await Promise.allSettled(missing.map(async p => {
    const spec = await generateJson({
      role: "hydrogen", job: `spec worker: ${p.title.slice(0, 40)}`,
      system: "Read the product listing and return its OVERALL assembled size in centimetres (inches x 2.54). Use only numbers stated in the text; return 0 for any you cannot find. Ignore box, seat and cushion sizes.",
      parts: [{ text: `Title: ${p.title}\nType: ${p.type}\nVariants: ${p.variants.map(v => v.title).join(", ").slice(0, 300)}\nListing: ${p.description.slice(0, 1800)}` }],
      schema: specSchema,
    });
    if (spec.w > 0) p.listingDims = { w: spec.w, d: spec.d || undefined, h: spec.h || undefined, raw: "read from listing by Hydrogen", source: "hydrogen", ...(p.listingDims ?? {}) };
  }));
  return products;
}

// ---------- Ranking (Decision 1) ----------
const MATCH_LEVELS = [
  "Wrong kind of product for this request.",
  "Right category but a poor match for the request or room.",
  "Reasonable match.",
  "Strong match for the request, style and space.",
  "Excellent: exactly what was asked for and suits the room.",
];

export function fitCheck(dims, space) {
  if (!dims?.w || !space?.width_cm) return { fits: "unknown" };
  const widthOk = dims.w <= space.width_cm;
  const depthOk = !dims.d || !space.depth_cm || dims.d <= space.depth_cm;
  return {
    fits: widthOk && depthOk ? "yes" : "no",
    margin_cm: Math.round(space.width_cm - dims.w),
    note: widthOk && depthOk
      ? `${Math.round(dims.w)} cm wide in a ~${Math.round(space.width_cm)} cm space`
      : `${Math.round(dims.w)} cm wide is more than the ~${Math.round(space.width_cm)} cm space`,
  };
}

export async function rankProducts({ products, request, room, space }) {
  if (!products.length) return [];
  // One Decisions API call scores every candidate as its own rubric question.
  const context = `Shopper request: "${request}". Room: ${room ? `${room.style} ${room.room_type}, palette ${room.palette?.join(", ")}` : "unknown"}. Open space: ${space?.width_cm ? `~${Math.round(space.width_cm)} cm wide` : "unknown"}.`;
  const questions = Object.fromEntries(products.map((p, i) => [`p${String(i).padStart(2, "0")}`, {
    type: "score",
    instructions: `Product: "${p.title}" from ${p.storeName}, $${p.price}, type "${p.type}"${p.listingDims?.w ? `, ${Math.round(p.listingDims.w)} cm wide` : ""}. ${p.description.slice(0, 200)} How well does it match the shopper's request and room?`,
    criteria: MATCH_LEVELS,
  }]));
  let ranking;
  try {
    const answers = await decide({ job: `rank ${products.length} products for this room`, input: [{ type: "text", text: context }], questions });
    ranking = products.map((p, i) => {
      const a = answers[`p${String(i).padStart(2, "0")}`];
      const s = rubric01(a, MATCH_LEVELS.length);
      return { id: p.id, score: s == null ? 0 : Math.round(s * 100), reason: s == null ? "" : `Decision 1 match ${Math.round(s * 100)}/100 · confidence ${Math.round((a.confidence ?? 0) * 100)}%` };
    });
  } catch {
    ranking = products.map((p, i) => ({ id: p.id, score: 50 - i, reason: "Store search order (Decisions API unavailable)." }));
  }
  const byId = new Map(ranking.map(r => [r.id, r]));
  // The arithmetic is never left to a model: fit is computed from the measured numbers.
  return products.map(p => ({ ...p, score: byId.get(p.id)?.score ?? 0, reason: byId.get(p.id)?.reason ?? "", fit: fitCheck(p.listingDims, space) }))
    .map(p => ({ ...p, score: p.fit.fits === "no" ? p.score - 40 : p.score }))
    .sort((a, b) => b.score - a.score);
}

// ---------- Dimensions ----------
const dimsSchema = S("OBJECT", {
  properties: {
    w: S("NUMBER", { description: "Overall width in cm (left to right as seen from the front)." }),
    d: S("NUMBER", { description: "Overall depth in cm (front to back)." }),
    h: S("NUMBER", { description: "Overall height in cm." }),
    evidence: str,
    confidence: S("STRING", { enum: ["low", "medium", "high"] }),
  },
  required: ["w", "d", "h", "evidence", "confidence"],
});

export async function resolveDims(product, photo) {
  const listed = product.listingDims;
  if (listed?.w && listed?.d && listed?.h) return { w: listed.w, d: listed.d, h: listed.h, source: `listing: ${listed.raw}`, confidence: "high" };
  const read = await generateJson({
    role: "neon", job: "read overall dimensions from the listing",
    system: "Extract the product's OVERALL assembled dimensions in centimetres. Prefer numbers stated in the text (convert inches x 2.54). Ignore box/packaging, seat, arm and cushion sub-dimensions. If a number is missing, estimate it from the photo and typical sizes for this kind of product, and say so in evidence.",
    parts: [{ text: `Title: ${product.title}\nType: ${product.type}\nListing: ${product.description}\nPartial dims parsed: ${JSON.stringify(listed)}` }, photo],
    schema: dimsSchema
  });
  return { w: listed?.w ?? read.w, d: listed?.d ?? read.d, h: listed?.h ?? read.h, source: read.evidence, confidence: read.confidence };
}

// ---------- 3D part model ----------
const SHAPES = ["box", "rounded_box", "cylinder", "sphere", "cone"];
const MATERIALS = ["fabric", "wood", "metal", "leather", "plastic", "glass", "ceramic", "stone", "rattan", "velvet", "boucle"];
const modelSchema = S("OBJECT", {
  properties: {
    name: str,
    category: str,
    parts: S("ARRAY", {
      items: S("OBJECT", {
        properties: {
          name: str,
          shape: S("STRING", { enum: SHAPES }),
          center_cm: vec3,
          size_cm: vec3,
          rotation_deg: vec3,
          color: S("STRING", { description: "Hex colour sampled from the photo, e.g. #c9b8a3" }),
          material: S("STRING", { enum: MATERIALS }),
        },
        required: ["name", "shape", "center_cm", "size_cm", "rotation_deg", "color", "material"],
      }),
    },
    ),
  },
  required: ["name", "category", "parts"],
});

const MODEL_RULES = `Build a 3D model of the product as a set of simple solid parts.
Coordinates in centimetres. x = width (left to right as seen from the front), y = up (the floor is y = 0), z = depth (front of the product is +z).
The product's footprint is centred on x = 0, z = 0. center_cm is the centre of each part; size_cm is its full extent [x, y, z] before rotation.
For a cylinder or cone, size_cm is [diameter, height, diameter]. Legs, frames, cushions, arms, backs, drawers, shades and bases should each be their own part.
Use 6 to 40 parts. Every part must touch another part or the floor. Sample real colours from the photo. Match the target overall dimensions exactly.`;

function rotate([x, y, z], [rx, ry, rz]) {
  const [a, b, c] = [rx, ry, rz].map(d => (d * Math.PI) / 180);
  let p = [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
  p = [p[0] * Math.cos(b) + p[2] * Math.sin(b), p[1], -p[0] * Math.sin(b) + p[2] * Math.cos(b)];
  return [p[0] * Math.cos(c) - p[1] * Math.sin(c), p[0] * Math.sin(c) + p[1] * Math.cos(c), p[2]];
}

function partBox(part) {
  const [sx, sy, sz] = part.size_cm.map(v => Math.abs(v) / 2);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const dx of [-sx, sx]) for (const dy of [-sy, sy]) for (const dz of [-sz, sz]) {
    const p = rotate([dx, dy, dz], part.rotation_deg ?? [0, 0, 0]);
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], p[i] + part.center_cm[i]);
      max[i] = Math.max(max[i], p[i] + part.center_cm[i]);
    }
  }
  return { min, max };
}

export function boundsOf(model) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of model.parts) {
    const box = partBox(part);
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], box.min[i]);
      max[i] = Math.max(max[i], box.max[i]);
    }
  }
  return { min, max, size: { w: max[0] - min[0], h: max[1] - min[1], d: max[2] - min[2] } };
}

// The plan the agent checks its own output against.
export function checkModel(model, dims, tolerance = 0.08) {
  const issues = [];
  const parts = Array.isArray(model?.parts) ? model.parts : [];
  if (parts.length < 3 || parts.length > 60) issues.push(`Has ${parts.length} parts; use 6 to 40.`);
  const bad = parts.filter(p => ![...(p.center_cm ?? []), ...(p.size_cm ?? [])].every(Number.isFinite)
    || p.center_cm?.length !== 3 || p.size_cm?.length !== 3 || p.size_cm.some(v => v <= 0));
  if (bad.length) issues.push(`Parts with invalid numbers: ${bad.map(p => p.name).join(", ")}.`);
  if (issues.length) return { ok: false, issues, error: null };
  const { min, size } = boundsOf(model);
  const error = {};
  for (const axis of ["w", "d", "h"]) {
    if (!dims?.[axis]) continue;
    error[axis] = (size[axis] - dims[axis]) / dims[axis];
    if (Math.abs(error[axis]) > tolerance) {
      issues.push(`Overall ${{ w: "width", d: "depth", h: "height" }[axis]} is ${size[axis].toFixed(1)} cm but must be ${dims[axis]} cm.`);
    }
  }
  if (Math.abs(min[1]) > 2) issues.push(`Lowest point is at y = ${min[1].toFixed(1)} cm; the product must stand on the floor (y = 0).`);
  const boxes = parts.map(partBox);
  const touching = (a, b) => [0, 1, 2].every(i => a.min[i] <= b.max[i] + 1.5 && b.min[i] <= a.max[i] + 1.5);
  const floating = parts.filter((p, i) => boxes[i].min[1] > 1.5 && !boxes.some((b, j) => j !== i && touching(boxes[i], b)));
  if (floating.length) issues.push(`Floating parts that touch nothing: ${floating.map(p => p.name).join(", ")}.`);
  return { ok: issues.length === 0, issues, error, size };
}

// Deterministic last step: stretch each axis to the measured size and stand it on the floor.
export function snapToDims(model, dims) {
  const { min, max, size } = boundsOf(model);
  const scale = [dims?.w ? dims.w / size.w : 1, dims?.h ? dims.h / size.h : 1, dims?.d ? dims.d / size.d : 1];
  const centre = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
  const flat = p => Math.abs(p.rotation_deg?.[0] ?? 0) < 1 && Math.abs(p.rotation_deg?.[2] ?? 0) < 1
    && Math.abs(((p.rotation_deg?.[1] ?? 0) % 90)) < 1;
  return {
    ...model,
    parts: model.parts.map(p => {
      const turned = flat(p) && Math.round(Math.abs(p.rotation_deg?.[1] ?? 0) / 90) % 2 === 1;
      const size_cm = turned
        ? [p.size_cm[0] * scale[2], p.size_cm[1] * scale[1], p.size_cm[2] * scale[0]]
        : p.size_cm.map((v, i) => v * scale[i]);
      return { ...p, center_cm: p.center_cm.map((v, i) => (v - centre[i]) * scale[i]), size_cm };
    }),
  };
}

// Carbon's thinking level for 3D builds: LOW keeps a live build in seconds; set BUILD_THINKING=MEDIUM for max quality.
const buildThinking = () => process.env.BUILD_THINKING || "LOW";

// Only axes the listing actually states are enforced. Unstated axes are left to Carbon's own estimate from the
// photos: in our eval (photo-only condition) Carbon's estimate beat Neon's text-based estimate (10.5% vs 11.9% error).
function sizeBrief(dims) {
  const named = { w: "width", d: "depth", h: "height" };
  const known = Object.keys(named).filter(k => dims?.[k]);
  if (!known.length) return "The listing does not state its size: estimate the real-world size carefully from the photos (reference objects, typical sizes for this kind of product).";
  const stated = known.map(k => `${named[k]} ${dims[k]} cm`).join(", ");
  const missing = Object.keys(named).filter(k => !dims?.[k]).map(k => named[k]);
  return `Target overall size: ${stated}.${missing.length ? ` Estimate the ${missing.join(" and ")} yourself from the photos.` : ""}`;
}

async function draftModel(product, dims, photos) {
  return generateJson({
    role: "carbon", job: "draft the 3D part model", thinking: buildThinking(),
    system: MODEL_RULES,
    parts: [{ text: `Product: ${product.title} (${product.type || "furniture"}) from ${product.storeName}.\n${sizeBrief(dims)}\nListing: ${product.description.slice(0, 1200)}` }, ...photos],
    schema: modelSchema
  });
}

async function repairModel(product, dims, photos, model, issues, job = "repair the 3D model") {
  return generateJson({
    role: "carbon", job, thinking: buildThinking(),
    system: MODEL_RULES,
    parts: [{ text: `Product: ${product.title}. ${sizeBrief(dims)}\nYour previous model failed these checks:\n- ${issues.join("\n- ")}\nFix every issue and return the full corrected model.\nPrevious model:\n${JSON.stringify(model)}` }, ...photos],
    schema: modelSchema
  });
}

// Finished (or in-flight) builds by product id, so a repeat request is instant and search can pre-build the top pick.
const builds = new Map();
export function buildModel(productId, options) {
  if (!builds.has(productId)) {
    const job = productById(productId).then(product => buildModelFor(product, options));
    builds.set(productId, job);
    job.catch(() => builds.delete(productId));
  }
  return builds.get(productId);
}
export function prebuild(productId) {
  buildModel(productId).catch(() => {});
}

// Baseline for the eval: one call, no dimension step, no checks, no repair, no snap.
export async function baselineModel(product) {
  const photos = await Promise.all((product.images.length ? product.images : [product.image]).slice(0, 2).map(url => fetchImagePart(url)));
  return generateJson({
    role: "carbon", job: "baseline: one-shot 3D model", thinking: buildThinking(),
    system: MODEL_RULES.replace(" Match the target overall dimensions exactly.", " Use the real-world size of the product."),
    parts: [{ text: `Product: ${product.title} (${product.type || "furniture"}) from ${product.storeName}.\nListing: ${product.description.slice(0, 1200)}` }, ...photos],
    schema: modelSchema
  });
}

export async function buildModelFor(product, { maxRepairs = 2 } = {}) {
  const started = Date.now();
  const photos = await Promise.all((product.images.length ? product.images : [product.image]).slice(0, 2).map(url => fetchImagePart(url)));
  const listed = product.listingDims;
  const dims = { w: listed?.w, d: listed?.d, h: listed?.h };
  const stated = ["w", "d", "h"].filter(k => dims[k]);
  const steps = [{ step: "dimensions", detail: stated.length
    ? `listing states ${stated.map(k => `${k.toUpperCase()} ${dims[k]} cm`).join(", ")}${stated.length < 3 ? "; Carbon estimates the rest from the photos" : ""}`
    : "listing has no size: Carbon estimates it from the photos" }];
  let model = await draftModel(product, dims, photos);
  let check = checkModel(model, dims);
  const firstCheck = check;
  steps.push({ step: "draft", detail: check.ok ? "passed every check" : check.issues.join(" ") });
  for (let round = 1; !check.ok && round <= maxRepairs; round += 1) {
    model = await repairModel(product, dims, photos, model, check.issues);
    check = checkModel(model, dims);
    steps.push({ step: `repair ${round}`, detail: check.ok ? "passed every check" : check.issues.join(" ") });
  }
  const final = check.issues.some(i => i.startsWith("Parts with invalid")) ? model : snapToDims(model, dims);
  steps.push({ step: "snap", detail: stated.length ? "stated axes locked to the listing; stood on the floor" : "stood on the floor at Carbon's estimated size" });
  const size = boundsOf(final).size;
  const finalDims = {
    w: Math.round(size.w * 10) / 10, d: Math.round(size.d * 10) / 10, h: Math.round(size.h * 10) / 10,
    source: stated.length === 3 ? `listing: ${listed.raw}` : stated.length ? "listing + Carbon estimate" : "Carbon estimate from photos",
    confidence: stated.length === 3 ? "high" : "estimated",
  };
  return {
    product: { id: product.id, title: product.title, image: product.image, price: product.price, storeName: product.storeName },
    dims: finalDims, model: final, steps,
    checks: { first: firstCheck, last: check, final: checkModel(final, dims) },
    models: { builder: MODELS.carbon(), dimensions: MODELS.neon() }, ms: Date.now() - started,
  };
}

// Visual self-check: the browser renders the model; Decision 1 scores likeness against the real photo,
// and only a low score spends a Neon critique + Carbon repair.
const LIKENESS = [
  "Unrecognisable: wrong kind of object.",
  "Right kind of object but wrong shape or parts.",
  "Recognisable, with clear differences in proportions, parts or colour.",
  "Close match with small differences.",
  "Same silhouette, parts, proportions and colours.",
];
const issuesSchema = S("OBJECT", { properties: { issues: S("ARRAY", { items: str }) }, required: ["issues"] });

export async function critiqueModel({ productId, render, model }) {
  const product = await productById(productId);
  const photo = await fetchImagePart(product.image);
  let likeness = null;
  let confidence = 0;
  try {
    const answers = await decide({
      job: "score the 3D render against the product photo",
      input: [
        { type: "text", text: `Image 1: real product photo of "${product.title}". Image 2: render of a simple part-based 3D model of it. Ignore lighting, background and fine texture.` },
        decisionImage(photo.inlineData.data, photo.inlineData.mimeType),
        decisionImage(render, "image/png"),
      ],
      questions: { likeness: { type: "score", instructions: "How closely does the render (image 2) match the product (image 1) in silhouette, parts, proportions and colour?", criteria: LIKENESS } },
    });
    likeness = rubric01(answers.likeness, LIKENESS.length);
    confidence = answers.likeness?.confidence ?? 0;
  } catch {
    // Decisions API unavailable: let Neon judge instead.
  }
  const score = likeness == null ? null : Math.round(likeness * 100) / 10;
  if (score != null && score >= 7) return { critique: { score, confidence, issues: [] }, model: null };
  const { issues } = await generateJson({
    role: "neon", job: "list differences between render and photo",
    system: "Image 1 is the real product photo. Image 2 is a render of a simple 3D model of it. List concrete, fixable differences in parts, proportions and colour (max 5, each under 18 words). Ignore lighting, background and texture detail. Return an empty list if it already matches well.",
    parts: [photo, imagePart(render, "image/png")],
    schema: issuesSchema,
  });
  const critique = { score: score ?? Math.max(0, 9 - issues.length * 1.5), confidence, issues };
  if (!issues.length || !model) return { critique, model: null };
  const photos = [photo];
  const listedDims = product.listingDims ?? {};
  const dims = { w: listedDims.w, d: listedDims.d, h: listedDims.h };
  const repaired = await repairModel(product, dims, photos, model, critique.issues, "repair the model after the visual check");
  return { critique, model: snapToDims(repaired, dims), check: checkModel(repaired, dims) };
}

// ---------- Staging in the caller's own frame ----------
export async function stageInRoom({ frame, productId, where }) {
  const product = await productById(productId);
  const photo = await fetchImagePart(product.image, 1024);
  const dims = product.listingDims;
  const size = dims?.w ? ` It is about ${Math.round(dims.w)} cm wide${dims.h ? ` and ${Math.round(dims.h)} cm tall` : ""}; keep that scale relative to the room.` : "";
  const image = await generateImage({
    job: `place ${product.title} in the caller's room`,
    parts: [
      { text: `Image 1 is a photo of my room from my phone camera. Image 2 is the product "${product.title}". Place exactly this product into my room ${where ? `(${where})` : "where it would naturally go"}, sitting on the floor with correct perspective, contact shadows and the room's lighting.${size} Keep everything else in my room exactly as it is. Do not change the camera angle.` },
      imagePart(frame),
      photo,
    ],
  });
  return { image: `data:${image.mimeType};base64,${image.data}`, product: { id: product.id, title: product.title } };
}

// ---------- Live redesign: Nano Banana restyles the real room, Neon turns the design into a shopping list ----------
const lookSchema = S("OBJECT", {
  properties: {
    summary: S("STRING", { description: "One sentence describing the new look." }),
    items: S("ARRAY", {
      items: S("OBJECT", {
        properties: {
          item: S("STRING", { description: "What the piece is, e.g. 'low oak media console'." }),
          search: S("STRING", { description: "2-3 word store search, e.g. 'media console'." }),
          approx_width_cm: num,
          colour: str,
        },
        required: ["item", "search", "approx_width_cm", "colour"],
      }),
    }),
  },
  required: ["summary", "items"],
});

// Default is "furnish": keep the real scene (people, walls, screens, lighting, camera) and only add or swap
// furniture and decor. "full" (walls/finishes too) happens only when the shopper explicitly asks for it.
const KEEP_RULES = `STRICT RULES:
- This is a real photo. Keep every person exactly as they are: same people, faces, poses, clothing and positions. Do not add, remove or move anyone.
- Keep the room itself exactly: walls, ceiling, floor, windows, doors, screens, stage, lighting rigs, signage and camera angle stay identical.
- Keep existing objects people are using (laptops, cups, bags) unless asked to clear them.
- Only ADD or SWAP furniture and decor that fits naturally around the people: seating, tables, rugs, plants, lamps, shelves, art, cushions, accents.
- Match the photo's real lighting, perspective, grain and colour so the new pieces look like they were physically there.`;

export async function redesignRoom({ frame, style, scope = "furnish" }) {
  const look = style || "warm modern: natural wood, soft textiles, plants";
  const full = scope === "full";
  const prompt = full
    ? `This is a live photo of a real room from my phone. Redesign it in this style: ${look}. You may change wall finishes and surfaces, but keep every person exactly as they are (same people, faces, poses, positions), keep the architecture, windows, doors and camera angle, and keep it photorealistic.`
    : `This is a live photo of a real room from my phone. Style it as an interior designer, in this direction: ${look}.\n${KEEP_RULES}`;
  let image = await generateImage({ job: `redesign (${full ? "full" : "furnish"}): ${look.slice(0, 36)}`, parts: [{ text: prompt }, imagePart(frame)] });

  // Decision 1 checks the edit kept the real scene; one stricter redraw if it didn't.
  let kept = null;
  try {
    const answers = await decide({
      job: "check the redesign kept the real room and people",
      input: [
        { type: "text", text: "Image 1 is the original photo. Image 2 is an interior-design edit of it." },
        decisionImage(frame), decisionImage(image.data, image.mimeType),
      ],
      questions: {
        same_people: { type: "noul", instructions: "Are the same people from image 1 still in image 2, in the same places (or were there no people in image 1)?" },
        same_room: { type: "noul", instructions: full
          ? "Is image 2 clearly the same room as image 1 (same architecture and camera angle)?"
          : "Does image 2 keep the same walls, ceiling, screens and background as image 1, changing mainly furniture and decor?" },
      },
    });
    kept = { people: answers.same_people?.noul ?? null, room: answers.same_room?.noul ?? null };
    if ((kept.people ?? 1) < 0.5 || (kept.room ?? 1) < 0.5) {
      image = await generateImage({
        job: "redesign redraw: keep people and room",
        parts: [{ text: `${prompt}\nYour last attempt changed the room or the people. Edit the ORIGINAL photo minimally: same people, same walls and background; only place furniture and decor into the existing scene.` }, imagePart(frame)],
      });
      kept.redrawn = true;
    }
  } catch {
    // Decisions API unavailable: keep the first image.
  }

  const plan = await generateJson({
    role: "neon", job: "turn the design into a shopping list",
    system: "You are an interior designer. Image 1 is the original room, image 2 is the edited version. List the 3 to 5 main pieces that are NEW in image 2 (not already in image 1) that someone could buy: furniture, rugs, lighting, plants, decor. Give a short store search phrase and an estimated width.",
    parts: [imagePart(frame), imagePart(image.data, image.mimeType)],
    schema: lookSchema,
  });
  return { image: `data:${image.mimeType};base64,${image.data}`, style: look, scope: full ? "full" : "furnish", kept, ...plan };
}

// ---------- Shop the look: find the closest real Shopify product for every piece in the design ----------
// Search runs per piece in parallel; Decision 1 picks the best candidate as one multiple-choice question per piece.
export async function matchLook(items) {
  const pieces = items.slice(0, 6);
  const pools = await Promise.all(pieces.map(it => searchProducts(String(it.search || it.item).slice(0, 60), { perStore: 3 }).catch(() => [])));
  const questions = {};
  pieces.forEach((it, i) => {
    const pool = pools[i].slice(0, 12);
    if (!pool.length) return;
    const criteria = Object.fromEntries(pool.map((p, j) => [`c${String(j).padStart(2, "0")}`,
      `${p.title} (${p.storeName}, $${p.price}${p.listingDims?.w ? `, ${Math.round(p.listingDims.w)} cm wide` : ""}, type "${p.type}")`]));
    criteria.other = "None of these is the right kind of item.";
    questions[`q${i}`] = { type: "choice", instructions: `Which product best matches this piece from an interior design: "${it.item}" (${it.colour || "any colour"}, about ${Math.round(it.approx_width_cm || 0)} cm wide)? Match the kind of item first, then colour and size.`, criteria };
  });
  let answers = {};
  if (Object.keys(questions).length) {
    try {
      answers = await decide({ job: `match ${pieces.length} designed pieces to Shopify products`, input: [{ type: "text", text: "Shopping for the pieces in an interior redesign." }], questions });
    } catch { answers = {}; }
  }
  return pieces.map((it, i) => {
    const pool = pools[i].slice(0, 12);
    const a = answers[`q${i}`];
    const idx = a?.choice && a.choice !== "other" ? Number(a.choice.slice(1)) : (a ? -1 : 0);
    const pick = idx >= 0 ? pool[idx] : null;
    const brief = p => p && { id: p.id, title: p.title, storeName: p.storeName, price: p.price, image: p.image, url: p.url, variants: p.variants, listingDims: p.listingDims };
    return {
      piece: it,
      match: brief(pick),
      confidence: a?.confidence ?? null,
      alternatives: pool.filter(p => p !== pick).slice(0, 2).map(brief),
    };
  });
}
