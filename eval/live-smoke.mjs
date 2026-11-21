// Live API smoke test: opens a real Gemini Live session with Space Theory's tools via an ephemeral token,
// sends one typed turn, and reports whether audio came back and which tool Theo called.
// Run: node --env-file=.env eval/live-smoke.mjs
import { GoogleGenAI, Modality } from "@google/genai";
import { liveToken } from "../server/gemini.mjs";
import { homeInstructions, homeTools } from "../shared/home-tools.mjs";

const { token, model } = await liveToken();
const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
const seen = { audioChunks: 0, toolCalls: [], transcript: "" };
let session;
const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve("timeout"), 25_000);
  ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: homeInstructions,
      tools: [{ functionDeclarations: homeTools }],
      outputAudioTranscription: {},
    },
    callbacks: {
      onopen: () => console.log("live: open"),
      onerror: e => { console.log("live: error", e?.message); clearTimeout(timer); resolve("error"); },
      onclose: e => console.log("live: closed", e?.code ?? "", e?.reason ?? ""),
      onmessage: m => {
        for (const p of m.serverContent?.modelTurn?.parts ?? []) if (p.inlineData?.data) seen.audioChunks += 1;
        if (m.serverContent?.outputTranscription?.text) seen.transcript += m.serverContent.outputTranscription.text;
        for (const fc of m.toolCall?.functionCalls ?? []) {
          seen.toolCalls.push(`${fc.name}(${JSON.stringify(fc.args)})`);
          session.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { output: { products: [{ id: "demo:sofa", title: "Lido Sofa 75\"", store: "Albany Park", price: 1528, fits: "yes" }] } } }] });
        }
        if (m.serverContent?.turnComplete && seen.audioChunks > 0) { clearTimeout(timer); resolve("turn complete"); }
      },
    },
  }).then(s => {
    session = s;
    s.sendClientContent({ turns: [{ role: "user", parts: [{ text: "Find me a sofa under $1,800." }] }], turnComplete: true });
  }).catch(e => { console.log("live: connect failed", e.message); resolve("connect failed"); });
});
console.log("result:", await done, JSON.stringify(seen));
session?.close();
process.exit(0);
