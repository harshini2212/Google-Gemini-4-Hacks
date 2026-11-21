// Space Theory server: JSON API for the browser app, plus Vite in dev or the built app in production.
// Only answers on localhost, or on the Wi-Fi address in phone mode (SPACE_PHONE=1).
import http from "node:http";
import https from "node:https";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chatStep, liveToken, MODELS, ProviderError, recentTrace } from "./gemini.mjs";
import { searchProducts, stores } from "./shopify.mjs";
import { commerceRoutes } from "./commerce.mjs";
import { buildModel, critiqueModel, fillSpecs, prebuild, rankProducts, redesignRoom, scanRoom, stageInRoom } from "./home.mjs";
import { homeInstructions, homeTools } from "../shared/home-tools.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT || 5180);
const DEV = process.argv.includes("--dev");
const PHONE = process.env.SPACE_PHONE === "1";
const PHONE_PORT = Number(process.env.SPACE_PHONE_PORT || 5443);
// Read fresh each time, so switching Wi-Fi or joining a phone hotspot works without a restart.
const wifiIps = () => Object.values(os.networkInterfaces()).flat()
  .filter(n => n && n.family === "IPv4" && !n.internal).map(n => n.address);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".json": "application/json",
};

function reply(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(payload));
}

// Reads a JSON body, refusing anything larger than `limit` bytes.
async function body(req, limit = 6_000_000) {
  let total = 0;
  const parts = [];
  for await (const piece of req) {
    total += piece.length;
    if (total > limit) throw new ProviderError(413, "That request is too big.");
    parts.push(piece);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
  } catch {
    throw new ProviderError(400, "Send a JSON body.");
  }
}

function cameraFrame(value) {
  const base64 = String(value ?? "").replace(/^data:image\/[a-z]+;base64,/, "");
  if (base64.length < 1000) throw new ProviderError(400, "Turn the camera on first so the designer can see the room.");
  return base64;
}

const api = {
  "GET /api/status": async () => ({
    ready: Boolean(process.env.GEMINI_API_KEY),
    models: Object.fromEntries(Object.entries(MODELS).map(([role, id]) => [role, id()])),
    stores: stores(),
  }),
  "GET /api/trace": async () => ({ trace: recentTrace() }),
  "POST /api/live-token": async () => liveToken(),
  "POST /api/scan": async req => {
    const { frame, goal } = await body(req);
    return scanRoom({ frame: cameraFrame(frame), goal: String(goal ?? "").slice(0, 300) });
  },
  "POST /api/products": async req => {
    const { query, max_price, space_width_cm, room } = await body(req, 200_000);
    const q = typeof query === "string" ? query.trim().slice(0, 80) : "";
    if (!q) throw new ProviderError(400, "Say what kind of product to look for.");
    const found = await searchProducts(q, { maxPrice: Number(max_price) || undefined });
    const space = Number(space_width_cm) > 0 ? { width_cm: Number(space_width_cm) } : room?.open_spaces?.[0] ?? null;
    const candidates = await fillSpecs(found.slice(0, 16));
    const ranked = await rankProducts({ products: candidates, request: q, room, space });
    if (ranked[0]) prebuild(ranked[0].id); // the top pick is usually what gets shown in 3D next
    return { products: ranked.slice(0, 6), space, searched: stores().length, checked: candidates.length };
  },
  "POST /api/model3d": async req => buildModel(String((await body(req, 10_000)).productId)),
  "POST /api/critique": async req => {
    const { productId, render, model } = await body(req);
    return critiqueModel({ productId: String(productId), render: cameraFrame(render), model });
  },
  "POST /api/stage": async req => {
    const { frame, productId, where } = await body(req);
    return stageInRoom({ frame: cameraFrame(frame), productId: String(productId), where: String(where ?? "").slice(0, 200) });
  },
  "POST /api/redesign": async req => {
    const { frame, style, scope } = await body(req);
    return redesignRoom({ frame: cameraFrame(frame), style: String(style ?? "").slice(0, 200), scope: scope === "full" ? "full" : "furnish" });
  },
  "POST /api/turn": async req => {
    const { contents } = await body(req, 400_000);
    if (!Array.isArray(contents) || contents.length === 0) throw new ProviderError(400, "Send the conversation so far.");
    return chatStep({ contents: contents.slice(-24), system: homeInstructions, tools: homeTools });
  },
  ...commerceRoutes({ body }), // cart, checkout and orders: server/commerce.mjs
};

function hostAllowed(host) {
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return true;
  return PHONE && wifiIps().some(ip => host === `${ip}:${PHONE_PORT}`);
}

async function serveBuilt(res, urlPath) {
  const file = urlPath === "/" ? path.join(BUILD_DIR, "index.html") : path.resolve(BUILD_DIR, "." + urlPath);
  if (!file.startsWith(BUILD_DIR + path.sep)) return reply(res, 404, { error: "Not found." });
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    reply(res, 404, { error: "Not found." });
  }
}

let vite = null;
async function route(req, res) {
  const host = req.headers.host ?? "";
  if (!hostAllowed(host)) return reply(res, 403, { error: "Open Space Theory on localhost." });
  const origin = `${req.socket.encrypted ? "https" : "http"}://${host}`;
  if (req.headers.origin && req.headers.origin !== origin) return reply(res, 403, { error: "Cross-site requests are blocked." });
  const urlPath = new URL(req.url, origin).pathname;
  const handler = api[`${req.method} ${urlPath}`];
  if (handler) return reply(res, 200, await handler(req));
  if (urlPath.startsWith("/api/")) return reply(res, 404, { error: "No such endpoint." });
  if (vite) return vite.middlewares(req, res);
  if (req.method !== "GET") return reply(res, 405, { error: "Use GET." });
  return serveBuilt(res, urlPath);
}

function onRequest(req, res) {
  route(req, res).catch(error => {
    if (error instanceof ProviderError) return reply(res, error.status, { error: error.message });
    console.error("request failed:", error?.message ?? error);
    reply(res, 500, { error: "Something went wrong on the server." });
  });
}

const server = http.createServer(onRequest);
if (DEV) {
  const { createServer } = await import("vite");
  vite = await createServer({ root: ROOT, appType: "spa", server: { middlewareMode: true, hmr: { server } } });
}
server.listen(PORT, "127.0.0.1", () => console.log(`Space Theory → http://localhost:${PORT}`));

// Phone mode: a self-signed HTTPS listener on the Wi-Fi address, because phone browsers only allow the camera over HTTPS.
if (PHONE) {
  const certDir = path.join(ROOT, ".certs");
  const keyFile = path.join(certDir, "key.pem");
  const certFile = path.join(certDir, "cert.pem");
  if (!fs.existsSync(certFile)) {
    fs.mkdirSync(certDir, { recursive: true });
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=Space Theory",
      "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  }
  https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, onRequest)
    .listen(PHONE_PORT, "0.0.0.0", () => wifiIps().forEach(ip => console.log(`Space Theory on your phone → https://${ip}:${PHONE_PORT}`)));
  // Print the new address whenever the network changes (e.g. after joining a phone hotspot).
  let last = wifiIps().join(",");
  setInterval(() => {
    const now = wifiIps().join(",");
    if (now !== last) { last = now; wifiIps().forEach(ip => console.log(`Network changed → open https://${ip}:${PHONE_PORT} on your phone`)); }
  }, 3000);
}
