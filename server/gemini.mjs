// Gemini 4 access for Space Theory. Model ids follow the Build with Gemini 4 Builder Guide.
// Every model has one job. Per the guide: no temperature/top-p on Gemini 4 models, only thinking levels.
import { GoogleGenAI } from "@google/genai";

export class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const MODELS = {
  // Gemini 3.8 Live: two-way voice + camera over WebSockets, calls Theo's tools.
  live: () => process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live",
  // Gemini 4 Carbon: deepest reasoning. Builds and repairs the measured 3D part model.
  carbon: () => process.env.GEMINI_CARBON_MODEL || "gemini-4-carbon",
  // Gemini 4 Neon: fast frontier analysis while the shopper waits. Reads the room, resolves dimensions, critiques renders.
  neon: () => process.env.GEMINI_NEON_MODEL || "gemini-4-neon",
  // Gemini 4 Hydrogen: fast workhorse. Typed chat agent and parallel spec-reading subagents.
  hydrogen: () => process.env.GEMINI_HYDROGEN_MODEL || "gemini-4-hydrogen",
  // Gemini Decision 1 (Decisions API): gates camera frames, ranks products, scores 3D likeness.
  decision: () => process.env.GEMINI_DECISION_MODEL || "gemini-decision-1",
  // Nano Banana 2.1: draws the chosen product into the shopper's own camera frame.
  image: () => process.env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1",
};

const THINKING = { carbon: "MEDIUM", neon: "MEDIUM", hydrogen: "LOW" };

let client;
let betaClient;
export function gemini() {
  if (!process.env.GEMINI_API_KEY) throw new ProviderError(503, "Add GEMINI_API_KEY to .env to wake Theo up.");
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}
function geminiBeta() {
  gemini();
  betaClient ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: "v1beta" } });
  return betaClient;
}

// Retry 503 "model overloaded" and transient network errors (per the hackathon account guide). Never retry 4xx.
async function withRetry(call, tries = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const status = error?.status ?? error?.code;
      const transient = status === 503 || status === 500 || status === "ECONNRESET" || /overloaded|unavailable|fetch failed/i.test(String(error?.message));
      if (!transient || attempt >= tries) throw error;
      await new Promise(r => setTimeout(r, 600 * 2 ** (attempt - 1) + Math.random() * 300));
    }
  }
}

// A running log of every model call, shown in the app so judges can see which model did which job.
const trace = [];
export function recentTrace() {
  return trace.slice(-40);
}
function record(entry) {
  trace.push({ at: Date.now() + Math.random(), ...entry });
  if (trace.length > 200) trace.splice(0, trace.length - 200);
}

function friendly(error) {
  const status = error?.status ?? error?.code;
  if (status === 429) return new ProviderError(429, "Gemini hit a rate or spend limit. Wait a few seconds, or raise the cap at aistudio.google.com/spend.");
  if (status === 400 || status === 404) return new ProviderError(502, `Gemini rejected the request (${String(error.message).slice(0, 180)}).`);
  return new ProviderError(502, `Gemini could not answer that request (${String(error?.message ?? "").slice(0, 120)}).`);
}

export function imagePart(base64, mimeType = "image/jpeg") {
  return { inlineData: { mimeType, data: base64 } };
}

export async function fetchImagePart(url, width = 768) {
  const sized = url.includes("cdn.shopify.com") || url.includes("/cdn/shop/")
    ? url + (url.includes("?") ? "&" : "?") + `width=${width}` : url;
  const response = await fetch(sized, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new ProviderError(502, "The product photo could not be loaded.");
  const type = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const bytes = Buffer.from(await response.arrayBuffer());
  return imagePart(bytes.toString("base64"), type.startsWith("image/") ? type : "image/jpeg");
}

// One structured call to Carbon, Neon or Hydrogen. Returns parsed JSON matching `schema`.
export async function generateJson({ role, job, parts, schema, system, thinking }) {
  const model = MODELS[role]();
  const started = Date.now();
  try {
    const response = await withRetry(() => gemini().models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseSchema: schema,
        thinkingConfig: { thinkingLevel: thinking ?? THINKING[role] ?? "MEDIUM" },
      },
    }));
    const value = JSON.parse(response.text ?? "");
    record({ role, model, job, ms: Date.now() - started, ok: true });
    return value;
  } catch (error) {
    record({ role, model, job, ms: Date.now() - started, ok: false });
    if (error instanceof SyntaxError) throw new ProviderError(502, "Gemini returned malformed JSON.");
    throw error instanceof ProviderError ? error : friendly(error);
  }
}

// Gemini Decision 1 on the Decisions API: calibrated yes/no, choice and rubric answers, no output tokens.
// `input` is an array of { type: "text", text } | { type: "image", data, mime_type } | { type: "image", uri }.
export async function decide({ job, input, questions }) {
  const model = MODELS.decision();
  const started = Date.now();
  try {
    const response = await withRetry(() => geminiBeta().decisions.create({ model, input, questions }));
    record({ role: "decision", model, job, ms: Date.now() - started, ok: true });
    return response.answers ?? {};
  } catch (error) {
    record({ role: "decision", model, job, ms: Date.now() - started, ok: false });
    throw friendly(error);
  }
}

// Rubric answers come back as a probability-weighted level; normalize to 0..1.
// Decision 1 returns the probability-weighted level index (0 .. levels-1), e.g. 3.79 of 0..4.
export function rubric01(answer, levels) {
  if (!answer || typeof answer.score !== "number") return null;
  return Math.max(0, Math.min(1, answer.score / Math.max(1, levels - 1)));
}

// Nano Banana image editing. Returns { mimeType, data } of the first image in the reply.
// If the model answers with text only, retry once, then fall back to the fast image model.
async function imageOnce(model, parts, job) {
  const started = Date.now();
  try {
    const response = await withRetry(() => gemini().models.generateContent({
      model, contents: [{ role: "user", parts }],
      config: { responseModalities: ["IMAGE"] },
    }));
    const image = (response.candidates?.[0]?.content?.parts ?? []).find(part => part.inlineData?.data && !part.thought);
    record({ role: "image", model, job, ms: Date.now() - started, ok: Boolean(image) });
    return image ? { mimeType: image.inlineData.mimeType || "image/png", data: image.inlineData.data } : null;
  } catch (error) {
    record({ role: "image", model, job, ms: Date.now() - started, ok: false });
    if (error?.status === 429) throw friendly(error);
    return null;
  }
}

export async function generateImage({ job, parts }) {
  const primary = MODELS.image();
  const fast = process.env.GEMINI_IMAGE_FAST_MODEL || "gemini-3.1-flash-lite-image";
  const image = await imageOnce(primary, parts, job)
    ?? await imageOnce(primary, [{ text: "Return an image only." }, ...parts], job + " (retry)")
    ?? await imageOnce(fast, parts, job + " (fast fallback)");
  if (!image) throw new ProviderError(502, "The image model did not return a picture.");
  return image;
}

// One step of the typed conversation on Hydrogen: may return function calls for the browser to run.
export async function chatStep({ contents, system, tools }) {
  const model = MODELS.hydrogen();
  const started = Date.now();
  try {
    const response = await withRetry(() => gemini().models.generateContent({
      model, contents,
      config: { systemInstruction: system, tools: [{ functionDeclarations: tools }], thinkingConfig: { thinkingLevel: "LOW" } },
    }));
    const content = response.candidates?.[0]?.content ?? { role: "model", parts: [] };
    record({ role: "hydrogen", model, job: "chat agent turn", ms: Date.now() - started, ok: true });
    return {
      content,
      text: (content.parts ?? []).filter(part => part.text && !part.thought).map(part => part.text).join("").trim(),
      functionCalls: (content.parts ?? []).filter(part => part.functionCall).map(part => part.functionCall),
    };
  } catch (error) {
    record({ role: "hydrogen", model, job: "chat agent turn", ms: Date.now() - started, ok: false });
    throw friendly(error);
  }
}

// Short-lived token so the browser can open a Live session without seeing the real key.
export async function liveToken() {
  const now = Date.now();
  try {
    const token = await gemini().authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(now + 2 * 60_000).toISOString(),
        httpOptions: { apiVersion: "v1alpha" },
      },
    });
    record({ role: "live", model: MODELS.live(), job: "open live session", ms: Date.now() - now, ok: true });
    return { token: token.name, model: MODELS.live() };
  } catch (error) {
    record({ role: "live", model: MODELS.live(), job: "open live session", ms: Date.now() - now, ok: false });
    throw friendly(error);
  }
}
