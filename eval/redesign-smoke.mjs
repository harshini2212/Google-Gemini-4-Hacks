// Redesign smoke test on a real room photo. Run: node --env-file=.env eval/redesign-smoke.mjs [image-url] [style]
import { writeFile } from "node:fs/promises";
import { redesignRoom } from "../server/home.mjs";
import { recentTrace } from "../server/gemini.mjs";

const url = process.argv[2] || "https://images.unsplash.com/photo-1554995207-c18c203602cb?w=1280";
const res = await fetch(url);
const frame = Buffer.from(await res.arrayBuffer()).toString("base64");
const t = Date.now();
const out = await redesignRoom({ frame, style: process.argv[3] || "cozy Japandi lounge" });
await writeFile(new URL("./results/redesign.jpg", import.meta.url), Buffer.from(out.image.split(",")[1], "base64")).catch(() => {});
console.log(`redesign ${Date.now() - t}ms:`, out.summary);
for (const it of out.items) console.log(`  - ${it.item} (${it.search}) ~${it.approx_width_cm} cm, ${it.colour}`);
console.log(recentTrace().map(x => `${x.role}:${x.ok ? "ok" : "FAIL"}:${x.ms}ms`).join(" "));
