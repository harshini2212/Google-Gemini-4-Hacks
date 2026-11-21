// Smoke test: one small real call to every model role. Run: node --env-file=.env eval/smoke.mjs
import { decide, generateImage, generateJson, liveToken, MODELS, recentTrace } from "../server/gemini.mjs";

const tiny = { type: "OBJECT", properties: { answer: { type: "STRING" } }, required: ["answer"] };
const results = {};
async function step(name, fn) {
  const t = Date.now();
  try {
    const out = await fn();
    results[name] = `ok ${Date.now() - t}ms ${JSON.stringify(out).slice(0, 140)}`;
  } catch (error) {
    results[name] = `FAIL ${Date.now() - t}ms ${error.message}`;
  }
  console.log(name.padEnd(9), results[name]);
}

console.log(MODELS.live(), MODELS.carbon(), MODELS.neon(), MODELS.hydrogen(), MODELS.decision(), MODELS.image());
await Promise.all([
  step("hydrogen", () => generateJson({ role: "hydrogen", job: "smoke", parts: [{ text: "Say hi in one word." }], schema: tiny })),
  step("neon", () => generateJson({ role: "neon", job: "smoke", parts: [{ text: "Say hi in one word." }], schema: tiny })),
  step("carbon", () => generateJson({ role: "carbon", job: "smoke", parts: [{ text: "Say hi in one word." }], schema: tiny })),
  step("decision", () => decide({ job: "smoke", input: [{ type: "text", text: "A grey three-seat sofa, 220 cm wide." }], questions: {
    is_seating: { type: "noul", instructions: "Is this a piece of seating furniture?" },
    match: { type: "score", instructions: "How well does it match a request for a sofa?", criteria: ["Wrong", "Poor", "OK", "Good", "Exact"] },
  } })),
  step("live", () => liveToken().then(t => ({ model: t.model, token: Boolean(t.token) }))),
  step("image", () => generateImage({ job: "smoke", parts: [{ text: "A tiny flat icon of a green sofa on white." }] }).then(i => ({ mime: i.mimeType, bytes: i.data.length }))),
]);
console.log(JSON.stringify(recentTrace().map(t => [t.role, t.model, t.ok]), null, 0));
