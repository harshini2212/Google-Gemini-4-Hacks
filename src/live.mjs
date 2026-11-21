// Gemini Live in the browser: the shopper's microphone and camera stream in, the designer's voice streams out,
// and her tool calls run against the same actions as the typed chat.
import { GoogleGenAI, Modality } from "@google/genai";
import { homeInstructions, homeTools } from "../shared/home-tools.mjs";

const worklet = `class Mic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) { this.buf.push(new Float32Array(ch)); this.n += ch.length; }
    if (this.n >= 1600) {
      const out = new Float32Array(this.n); let o = 0;
      for (const b of this.buf) { out.set(b, o); o += b.length; }
      this.port.postMessage(out, [out.buffer]); this.buf = []; this.n = 0;
    }
    return true;
  }
}
registerProcessor("space-mic", Mic);`;

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function pcm16(floats) {
  const out = new Int16Array(floats.length);
  for (let i = 0; i < floats.length; i += 1) out[i] = Math.max(-1, Math.min(1, floats[i])) * 0x7fff;
  return toBase64(new Uint8Array(out.buffer));
}

export async function connectLive({ grabFrame, onTool, onEvent, signal }) {
  const tokenResponse = await fetch("/api/live-token", { method: "POST", signal });
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) throw new Error(tokenData.error || "Could not open a live session.");

  const ai = new GoogleGenAI({ apiKey: tokenData.token, httpOptions: { apiVersion: "v1alpha" } });
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const inCtx = new AudioContext({ sampleRate: 16000 });
  const outCtx = new AudioContext({ sampleRate: 24000 });
  let playhead = 0;
  const playing = new Set();
  let closed = false;
  let videoTimer;
  let speakingTimer;

  function stopPlayback() {
    for (const source of playing) { try { source.stop(); } catch { /* already stopped */ } }
    playing.clear();
    playhead = 0;
  }

  function play(base64) {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const samples = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    const buffer = outCtx.createBuffer(1, samples.length, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 0x8000;
    const source = outCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(outCtx.destination);
    playhead = Math.max(playhead, outCtx.currentTime + 0.02);
    source.start(playhead);
    playhead += buffer.duration;
    playing.add(source);
    source.onended = () => playing.delete(source);
    onEvent({ type: "speaking" });
    clearTimeout(speakingTimer);
    speakingTimer = setTimeout(() => onEvent({ type: "listening" }), (playhead - outCtx.currentTime) * 1000 + 250);
  }

  let session;
  const ready = new Promise((resolve, reject) => {
    ai.live.connect({
      model: tokenData.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: homeInstructions,
        tools: [{ functionDeclarations: homeTools }],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
      },
      callbacks: {
        onopen: () => resolve(),
        onerror: event => { onEvent({ type: "error", message: event?.message || "The live connection failed." }); reject(new Error("The live connection failed.")); },
        onclose: event => { if (!closed) onEvent({ type: "closed", reason: event?.reason }); },
        onmessage: async message => {
          const content = message.serverContent;
          if (content?.interrupted) { stopPlayback(); onEvent({ type: "listening" }); }
          for (const part of content?.modelTurn?.parts ?? []) if (part.inlineData?.data) play(part.inlineData.data);
          if (content?.inputTranscription?.text) onEvent({ type: "user-text", text: content.inputTranscription.text });
          if (content?.outputTranscription?.text) onEvent({ type: "ai-text", text: content.outputTranscription.text });
          if (content?.turnComplete) onEvent({ type: "turn-complete" });
          const calls = message.toolCall?.functionCalls ?? [];
          if (calls.length) {
            onEvent({ type: "thinking" });
            const functionResponses = await Promise.all(calls.map(async call => {
              let output;
              try { output = await onTool(call.name, call.args ?? {}); } catch (error) { output = { error: error.message }; }
              return { id: call.id, name: call.name, response: { output } };
            }));
            if (!closed) session.sendToolResponse({ functionResponses });
          }
        },
      },
    }).then(s => { session = s; }).catch(reject);
  });
  await ready;
  while (!session) await new Promise(r => setTimeout(r, 10));

  await inCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([worklet], { type: "text/javascript" })));
  const source = inCtx.createMediaStreamSource(mic);
  const node = new AudioWorkletNode(inCtx, "space-mic");
  node.port.onmessage = ({ data }) => {
    if (!closed) session.sendRealtimeInput({ audio: { data: pcm16(data), mimeType: "audio/pcm;rate=16000" } });
  };
  source.connect(node);

  videoTimer = setInterval(() => {
    const frame = grabFrame(640, 0.6);
    if (frame && !closed) session.sendRealtimeInput({ video: { data: frame, mimeType: "image/jpeg" } });
  }, 1000);

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(videoTimer);
    clearTimeout(speakingTimer);
    stopPlayback();
    mic.getTracks().forEach(track => track.stop());
    inCtx.close();
    outCtx.close();
    try { session.close(); } catch { /* already closed */ }
  }
  signal?.addEventListener("abort", close, { once: true });

  return {
    close,
    say(text) {
      session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
    },
  };
}
