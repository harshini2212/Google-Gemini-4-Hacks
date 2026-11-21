// Space Theory app: live camera stage, the designer (the voice/chat guide), product shelf, cart, and a model-activity log.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Box, Camera, CameraOff, Check, CircleStop, Mic, Orbit, Ruler, Scale, ScanLine, Send, ShoppingBag, Sparkles, Wand2,
} from "lucide-react";
import "@fontsource-variable/dm-sans";
import "./app.css";
import { ModelView } from "./model-view.jsx";
import { connectLive } from "./live.mjs";
import { CartBar } from "./commerce/cart.jsx";
import { makeCartItem, startCheckout } from "./commerce/client.mjs";

const STARTERS = [
  "Redesign this room as a cozy Japandi lounge",
  "What would make this room feel finished?",
  "Find a sofa that fits this wall, under $1,800",
  "I need a floor lamp for this corner",
];
const ROLE = { live: "Live", carbon: "Carbon", neon: "Neon", hydrogen: "Hydrogen", decision: "Decision", image: "Image" };

async function call(url, payload) {
  const res = await fetch(url, payload === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request to ${url} failed.`);
  return data;
}

const usd = n => "$" + Math.round(Number(n)).toLocaleString("en-US");
const toCm = n => (n ? `${Math.round(n)} cm` : "–");
const toIn = n => (n ? `${Math.round(n / 2.54)}″` : "–");

/* ---------- top bar ---------- */
function TopBar({ status }) {
  return (
    <header className="st-bar">
      <div className="st-brand"><Orbit size={22} strokeWidth={1.6} /> <span>Space Theory</span></div>
      <div className="st-models">
        {status?.models && Object.entries(status.models).map(([role, id]) => (
          <span key={role} className={`chip chip-${role}`} title={id}>{ROLE[role]}<em>{id}</em></span>
        ))}
        {status && !status.ready && <span className="chip chip-warn">GEMINI_API_KEY missing</span>}
      </div>
    </header>
  );
}

/* ---------- live model rail: which Gemini model is doing which job, right now ---------- */
const WHY = {
  decision: "instant yes/no, rank, score",
  neon: "analysis while you wait",
  hydrogen: "parallel workers",
  carbon: "deepest reasoning",
  image: "in-room preview",
  live: "voice + camera",
};
function plainJob(job) {
  if (/^gate/.test(job)) return "is this a room?";
  if (/^spec worker/.test(job)) return "read product specs";
  if (/^rank/.test(job)) return job.replace(" for this room", "");
  if (/read the room/.test(job)) return "measure the room";
  if (/draft the 3D/.test(job)) return "build 3D at true size";
  if (/repair/.test(job)) return "repair the 3D model";
  if (/score the 3D render/.test(job)) return "score 3D vs photo";
  if (/differences/.test(job)) return "spot differences";
  if (/^place /.test(job)) return "place in your room";
  if (/chat agent/.test(job)) return "plan next step";
  if (/live session/.test(job)) return "open the call";
  return job;
}
function ModelRail({ trace, busy }) {
  const since = Date.now() - 90_000;
  const recent = trace.filter(t => t.at >= since);
  const steps = [];
  for (const t of recent) {
    const job = plainJob(t.job);
    const last = steps[steps.length - 1];
    if (last && last.role === t.role && last.job === job) { last.count += 1; last.ms = Math.max(last.ms, t.ms); last.ok = last.ok && t.ok; }
    else steps.push({ role: t.role, job, count: 1, ms: t.ms, ok: t.ok });
  }
  const shown = steps.slice(-6);
  if (!shown.length && !busy) return <div className="rail rail-idle">Each step below names the Gemini model doing it, live.</div>;
  return (
    <div className="rail" aria-live="polite">
      {shown.map((st, i) => (
        <div key={i} className={`rail-step rail-${st.role}${st.ok ? "" : " rail-fail"}`}>
          <b>{ROLE[st.role] ?? st.role}{st.count > 1 ? ` ×${st.count}` : ""}</b>
          <span>{st.job}</span>
          <small>{st.job === "plan next step" ? "fast agent" : WHY[st.role]} · {(st.ms / 1000).toFixed(1)}s</small>
        </div>
      ))}
      {busy && <div className="rail-step rail-busy"><i className="spin" /><span>{busy}</span></div>}
    </div>
  );
}

/* ---------- camera / 3D / staged stage ---------- */
function Stage({ videoRef, cameraOn, toggleCamera, view, setView, build, critique, staged, modelRef, busy, trace, act }) {
  const views = [
    { id: "room", label: "Room", icon: Camera, enabled: true },
    { id: "model", label: "3D", icon: Box, enabled: Boolean(build) },
    { id: "staged", label: staged?.items ? "Redesign" : "In your room", icon: Wand2, enabled: Boolean(staged) },
  ];
  return (
    <section className="panel stage-panel">
      <nav className="seg">
        {views.map(v => (
          <button key={v.id} type="button" disabled={!v.enabled} className={view === v.id ? "on" : ""} onClick={() => setView(v.id)}>
            <v.icon size={15} /> {v.label}
          </button>
        ))}
        <button type="button" className="seg-cam" onClick={toggleCamera} aria-label={cameraOn ? "Camera off" : "Camera on"}>
          {cameraOn ? <CameraOff size={16} /> : <Camera size={16} />}
        </button>
      </nav>
      <div className="viewport">
        <video ref={videoRef} className={view === "staged" ? "feed gone" : "feed"} autoPlay muted playsInline />
        {!cameraOn && view === "room" && (
          <div className="viewport-empty">
            <ScanLine size={34} strokeWidth={1.3} />
            <p>Point your camera at the space you want to furnish.</p>
            <button type="button" className="btn btn-accent" onClick={toggleCamera}><Camera size={15} /> Start camera</button>
          </div>
        )}
        {build && view !== "staged" && (
          <ModelView ref={modelRef} model={build.model} overlay={view === "room" && cameraOn} spin={view === "model"} />
        )}
        {view === "staged" && staged && <img className="staged-img" src={staged.image} alt={`${staged.product.title} previewed in your room`} />}
        {build && view !== "staged" && (build.compare ? (
          <div className="hud hud-bottom"><Ruler size={14} />
            {build.compare.map((c, i) => <span key={i}>{i ? " · " : ""}{i ? "Right" : "Left"}: {c.product.title} {toCm(c.dims.w)} W × {toCm(c.dims.h)} H</span>)}
            <small>person = 170 cm</small></div>
        ) : (
          <div className="hud hud-bottom"><Ruler size={14} />{build.product.title} · {toCm(build.dims.w)} W × {toCm(build.dims.d)} D × {toCm(build.dims.h)} H
            <small>{toIn(build.dims.w)} × {toIn(build.dims.d)} × {toIn(build.dims.h)}{view === "model" ? " · person = 170 cm" : ""}</small></div>
        ))}
        {view === "staged" && staged?.items ? (
          <div className="look">
            <p><Wand2 size={14} /> {staged.summary}</p>
            <div className="look-items">
              {staged.items.map(it => (
                <button type="button" key={it.item} onClick={() => act("find_products", { query: it.search })}>
                  <ShoppingBag size={13} /> {it.item}<small>~{Math.round(it.approx_width_cm)} cm</small>
                </button>
              ))}
            </div>
          </div>
        ) : view === "staged" && <div className="hud hud-bottom"><Wand2 size={14} />Generated preview. Colours and details may differ slightly.</div>}
        {busy && <div className="hud hud-top"><i className="spin" />{busy}</div>}
      </div>
      {build ? (
        <>
        <ModelRail trace={trace} busy={busy} />
        <ul className="checklist">
          {build.steps.map((s, i) => <li key={i}><Check size={13} /><b>{s.step}</b><span>{s.detail}</span></li>)}
          {critique && <li><Check size={13} /><b>visual check</b><span>{critique.score}/10 likeness{critique.issues?.length ? ` · ${critique.issues.slice(0, 2).join("; ")}` : ""}</span></li>}
        </ul>
        </>
      ) : (
        <>
        <ModelRail trace={trace} busy={busy} />
        <p className="stage-hint">the designer sees your room, finds real products on Shopify, and rebuilds each one in 3D at its true size.</p>
        </>
      )}
    </section>
  );
}

/* ---------- the designer: voice + chat ---------- */
function Designer({ log, live, pending, voice, error, clearError, send, startVoice, stopVoice }) {
  const [draft, setDraft] = useState("");
  const scroller = useRef(null);
  const onCall = ["connecting", "listening", "thinking", "speaking"].includes(voice);
  const label = { idle: "Ready", connecting: "Connecting…", listening: "Listening", thinking: "Working…", speaking: "Speaking" }[voice];
  useEffect(() => { scroller.current.scrollTop = scroller.current.scrollHeight; }, [log, live, pending]);
  const submit = e => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || pending) return;
    send(text);
    setDraft("");
  };
  return (
    <aside className="panel designer">
      <header className="designer-head">
        <div className={onCall ? "orb orb-on" : "orb"}><Sparkles size={18} /></div>
        <div><h2>Designer</h2><p>{label}</p></div>
        <button type="button" className={onCall ? "btn btn-stop" : "btn btn-accent"} onClick={onCall ? stopVoice : startVoice}>
          {onCall ? <><CircleStop size={15} /> End call</> : <><Mic size={15} /> Start call</>}
        </button>
      </header>
      <div className="feedlog" ref={scroller} aria-live="polite">
        <p className="msg msg-ai">Hey! I'm your Space Theory designer. Show me your room and tell me what you need. I'll find real pieces that fit, show them in 3D at true size, and get them in your cart.</p>
        {log.map(m => <p key={m.id} className={`msg msg-${m.who}`}>{m.text}</p>)}
        {live && <p className="msg msg-ai">{live}</p>}
        {pending && <p className="msg msg-ai typing"><span /><span /><span /></p>}
        {!log.length && !pending && (
          <div className="starters">{STARTERS.map(s => <button type="button" key={s} onClick={() => send(s)}>{s}</button>)}</div>
        )}
      </div>
      {error && <div className="alert" role="alert"><span>{error}</span><button type="button" onClick={clearError} aria-label="Dismiss">×</button></div>}
      <form className="composer" onSubmit={submit}>
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Message the designer…" maxLength={500} aria-label="Message the designer" />
        <button type="submit" disabled={!draft.trim() || pending} aria-label="Send"><Send size={17} /></button>
      </form>
    </aside>
  );
}

/* ---------- product shelf ---------- */
function Fit({ fit, dims }) {
  if (!fit || fit.fits === "unknown") return <span className="tag tag-muted">{dims?.w ? "Fit not checked yet" : "Size not listed"}</span>;
  return fit.fits === "yes"
    ? <span className="tag tag-ok" title={fit.note}>Fits · {fit.margin_cm} cm to spare</span>
    : <span className="tag tag-bad" title={fit.note}>Too wide for the space</span>;
}

function Shelf({ products, room, act, cart }) {
  const [pick, setPick] = useState(null);
  if (!products.length) return null;
  const compare = id => {
    if (!pick) return setPick(id);
    if (pick !== id) act("compare_in_3d", { product_id_a: pick, product_id_b: id });
    setPick(null);
  };
  return (
    <section className="shelf">
      <h3>Real products from Shopify stores{room?.style ? <span> · ranked for your {room.style.toLowerCase()} {room.room_type?.toLowerCase()}</span> : null}</h3>
      <div className="shelf-grid">
        {products.map(p => (
          <article className="card" key={p.id}>
            <img src={p.image ? `${p.image}${p.image.includes("?") ? "&" : "?"}width=480` : ""} alt="" loading="lazy" />
            <div className="card-body">
              <small>{p.storeName}</small>
              <h4>{p.title}</h4>
              <p><b>{usd(p.price)}</b>{p.listingDims?.w ? ` · ${toCm(p.listingDims.w)} wide` : ""}</p>
              <Fit fit={p.fit} dims={p.listingDims} />
              {p.reason && <p className="card-why">{p.reason}</p>}
              <div className="card-actions">
                <button type="button" onClick={() => act("show_in_3d", { product_id: p.id })}><Box size={14} /> 3D</button>
                <button type="button" onClick={() => act("place_in_room", { product_id: p.id })}><Wand2 size={14} /> Place</button>
                <button type="button" className={pick === p.id ? "picked" : ""} onClick={() => compare(p.id)} title={pick && pick !== p.id ? "Compare with the one you picked" : "Pick to compare"}>
                  <Scale size={14} /> {pick === p.id ? "Pick 2nd" : "VS"}</button>
                <button type="button" className="buy" onClick={() => act("add_to_cart", { product_id: p.id })}>
                  {cart.some(c => c.productId === p.id) ? <Check size={14} /> : <ShoppingBag size={14} />} Add
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/* ---------- which model did what ---------- */
function ModelLog({ trace }) {
  if (!trace.length) return null;
  return (
    <section className="modellog">
      <h3>Which Gemini model did what</h3>
      <ol>
        {trace.slice(-8).reverse().map(t => (
          <li key={t.at}>
            <span className={`chip chip-${t.role}`}>{ROLE[t.role] ?? t.role}</span>
            <span className="ml-job">{t.job}</span>
            <code>{t.model}</code>
            <span className={t.ok ? "ml-ms" : "ml-ms ml-fail"}>{t.ok ? `${(t.ms / 1000).toFixed(1)}s` : "failed"}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ---------- app ---------- */
function App() {
  const [status, setStatus] = useState(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [view, setView] = useState("room");
  const [room, setRoom] = useState(null);
  const [products, setProducts] = useState([]);
  const [build, setBuild] = useState(null);
  const [critique, setCritique] = useState(null);
  const [staged, setStaged] = useState(null);
  const [cart, setCart] = useState([]);
  const [checkouts, setCheckouts] = useState(null);
  const [busy, setBusy] = useState("");
  const [log, setLog] = useState([]);
  const [live, setLive] = useState("");
  const [pending, setPending] = useState(false);
  const [voice, setVoice] = useState("idle");
  const [error, setError] = useState("");
  const [trace, setTrace] = useState([]);
  const videoRef = useRef(null);
  const modelRef = useRef(null);
  const frameCanvas = useRef(null);
  const session = useRef(null);
  const sessionAbort = useRef(null);
  const history = useRef([]);
  const heard = useRef("");
  const latest = useRef({});
  latest.current = { room, products, cart, cameraOn };

  useEffect(() => {
    call("/api/status").then(setStatus).catch(() => {});
    const t = setInterval(() => call("/api/trace").then(d => setTrace(d.trace)).catch(() => {}), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { if (import.meta.env.DEV) window.__space = { setBuild, setProducts, setView, act }; });

  const say = (who, text) => text?.trim() && setLog(l => [...l.slice(-39), { id: crypto.randomUUID(), who, text: text.trim() }]);

  async function cameraStart() {
    try {
      videoRef.current.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } } });
      setCameraOn(true);
      setView("room");
    } catch {
      setError("Allow camera access so the designer can see your room.");
    }
  }
  function cameraStop() {
    videoRef.current?.srcObject?.getTracks().forEach(t => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }

  function snap(width = 1024, quality = 0.82) {
    const v = videoRef.current;
    if (!v?.videoWidth) return null;
    const c = (frameCanvas.current ??= document.createElement("canvas"));
    c.width = width;
    c.height = Math.round(width * v.videoHeight / v.videoWidth);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality).split(",")[1];
  }

  const byId = id => latest.current.products.find(p => p.id === id);

  async function selfCheck(result) {
    await new Promise(r => setTimeout(r, 900)); // let three.js draw the new model first
    const render = modelRef.current?.snapshot();
    if (!render) return;
    try {
      const out = await call("/api/critique", { productId: result.product.id, render, model: result.model });
      setCritique(out.critique);
      if (out.model) setBuild(b => b?.product.id === result.product.id
        ? { ...b, model: out.model, steps: [...b.steps, { step: "visual repair", detail: out.critique.issues.slice(0, 3).join("; ") }] } : b);
    } catch { /* the check is a bonus; the model is already shown */ }
  }

  // Every tool the designer can use, whether the live call or the typed chat asked for it.
  async function act(name, args = {}) {
    try {
      if (name === "look_at_room") {
        const frame = snap();
        if (!frame) return { error: "The camera is off." };
        setBusy("Reading your room…");
        const scan = await call("/api/scan", { frame, goal: args.goal });
        setRoom(scan);
        return scan;
      }
      if (name === "redesign_room") {
        const frame = snap(1280, 0.9);
        if (!frame) return { error: "The camera is off." };
        setBusy(`Redesigning your room: ${args.style || "designer's pick"}…`);
        const out = await call("/api/redesign", { frame, style: args.style });
        setStaged({ image: out.image, product: { title: `${out.style} redesign` }, items: out.items, summary: out.summary });
        setView("staged");
        return { look: out.summary, pieces: out.items };
      }
      if (name === "find_products") {
        setBusy(`Searching Shopify for “${args.query}”…`);
        const out = await call("/api/products", { ...args, room: latest.current.room });
        setProducts(out.products);
        return {
          space_used: out.space,
          products: out.products.map(p => ({
            id: p.id, title: p.title, store: p.storeName, price: p.price, fits: p.fit.fits, fit_note: p.fit.note, why: p.reason,
            size_cm: p.listingDims ? { w: p.listingDims.w, d: p.listingDims.d, h: p.listingDims.h } : "not listed",
          })),
        };
      }
      if (name === "show_in_3d") {
        setBusy(`Building ${byId(args.product_id)?.title ?? "it"} in 3D…`);
        const result = await call("/api/model3d", { productId: args.product_id });
        setCritique(null);
        setBuild(result);
        setView(latest.current.cameraOn ? "room" : "model");
        selfCheck(result);
        return { shown: result.product.title, size_cm: result.dims, size_source: result.dims.source,
          passed_checks_first_try: result.checks.first.ok, repairs: result.steps.filter(s => s.step.startsWith("repair")).length };
      }
      if (name === "compare_in_3d") {
        const [a, b] = [byId(args.product_id_a), byId(args.product_id_b)];
        setBusy(`Building ${a?.title ?? "both"} and ${b?.title ?? "the other"} side by side…`);
        const [ra, rb] = await Promise.all([
          call("/api/model3d", { productId: args.product_id_a }),
          call("/api/model3d", { productId: args.product_id_b }),
        ]);
        const gap = 40; // cm between the two pieces
        const shift = ra.dims.w / 2 + gap + rb.dims.w / 2;
        const merged = {
          name: `${ra.product.title} vs ${rb.product.title}`,
          parts: [
            ...ra.model.parts.map(p => ({ ...p, center_cm: [p.center_cm[0] - shift / 2, p.center_cm[1], p.center_cm[2]] })),
            ...rb.model.parts.map(p => ({ ...p, center_cm: [p.center_cm[0] + shift / 2, p.center_cm[1], p.center_cm[2]] })),
          ],
        };
        setCritique(null);
        setBuild({
          product: { id: `${ra.product.id}|${rb.product.id}`, title: `${ra.product.title} (left) vs ${rb.product.title} (right)` },
          dims: { w: ra.dims.w + gap + rb.dims.w, d: Math.max(ra.dims.d, rb.dims.d), h: Math.max(ra.dims.h, rb.dims.h) },
          compare: [ra, rb],
          model: merged,
          steps: [
            { step: "left", detail: `${ra.product.title}: ${toCm(ra.dims.w)} W × ${toCm(ra.dims.d)} D × ${toCm(ra.dims.h)} H · ${ra.dims.source}` },
            { step: "right", detail: `${rb.product.title}: ${toCm(rb.dims.w)} W × ${toCm(rb.dims.d)} D × ${toCm(rb.dims.h)} H · ${rb.dims.source}` },
          ],
          checks: { first: { ok: ra.checks.first.ok && rb.checks.first.ok } },
        });
        setView("model");
        return {
          left: { title: ra.product.title, size_cm: ra.dims }, right: { title: rb.product.title, size_cm: rb.dims },
          width_difference_cm: Math.round(Math.abs(ra.dims.w - rb.dims.w)),
        };
      }
      if (name === "place_in_room") {
        const frame = snap(1280, 0.9);
        if (!frame) return { error: "The camera is off." };
        setBusy("Placing it in your room…");
        const out = await call("/api/stage", { frame, productId: args.product_id, where: args.where });
        setStaged(out);
        setView("staged");
        return { placed: out.product.title };
      }
      if (name === "add_to_cart") {
        const item = await makeCartItem(byId(args.product_id) ?? args.product_id, args.quantity);
        setCart(c => [...c.filter(x => x.productId !== item.productId), item]);
        return { added: item.title, variant: item.variantTitle, quantity: item.quantity };
      }
      if (name === "checkout") {
        if (!latest.current.cart.length) return { error: "The cart is empty." };
        setBusy("Preparing checkout…");
        const out = await startCheckout(latest.current.cart);
        setCheckouts(out.checkouts);
        return { stores: out.checkouts.map(c => ({ store: c.storeName, total: c.total })), note: "Checkout is on screen; the shopper confirms and pays." };
      }
      return { error: `Unknown tool ${name}.` };
    } catch (e) {
      setError(e.message);
      return { error: e.message };
    } finally {
      setBusy("");
    }
  }

  async function send(text) {
    setError("");
    say("you", text);
    if (session.current) return session.current.say(text);
    setPending(true);
    try {
      history.current.push({ role: "user", parts: [{ text }] });
      for (let i = 0; i < 6; i += 1) {
        const turn = await call("/api/turn", { contents: history.current });
        history.current.push(turn.content);
        if (turn.text) say("ai", turn.text);
        if (!turn.functionCalls.length) break;
        const parts = [];
        for (const fc of turn.functionCalls) parts.push({ functionResponse: { name: fc.name, response: { output: await act(fc.name, fc.args ?? {}) } } });
        history.current.push({ role: "user", parts });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }

  async function startVoice() {
    if (session.current) return;
    if (!latest.current.cameraOn) await cameraStart();
    const abort = new AbortController();
    sessionAbort.current = abort;
    setVoice("connecting");
    setError("");
    try {
      session.current = await connectLive({
        signal: abort.signal, grabFrame: snap, onTool: act,
        onEvent(ev) {
          if (ev.type === "speaking" || ev.type === "listening" || ev.type === "thinking") setVoice(ev.type);
          else if (ev.type === "user-text") heard.current += ev.text;
          else if (ev.type === "ai-text") {
            if (heard.current) { say("you", heard.current); heard.current = ""; }
            setLive(t => t + ev.text);
          } else if (ev.type === "turn-complete") setLive(t => { say("ai", t); return ""; });
          else if (ev.type === "error") setError(ev.message);
          else if (ev.type === "closed") { stopVoice(); setError("The call ended. Tap Start call to reconnect."); }
        },
      });
      setVoice("listening");
      session.current.say("Hi! I'm showing you my room now.");
    } catch (e) {
      stopVoice();
      setError(e.name === "NotAllowedError" ? "Allow the microphone to talk to the designer." : e.message);
    }
  }
  function stopVoice() {
    sessionAbort.current?.abort();
    sessionAbort.current = null;
    session.current = null;
    setVoice("idle");
    setLive("");
  }

  return (
    <>
      <TopBar status={status} />
      <main className="st-main">
        <section className="hero">
          <p className="kicker">Shop your room on a live call</p>
          <h1>See it in your space, at true size, before you buy.</h1>
        </section>
        <div className="layout">
          <Stage videoRef={videoRef} cameraOn={cameraOn} toggleCamera={cameraOn ? cameraStop : cameraStart} view={view} setView={setView}
            build={build} critique={critique} staged={staged} modelRef={modelRef} busy={busy} trace={trace} act={act} />
          <Designer log={log} live={live} pending={pending} voice={voice} error={error} clearError={() => setError("")}
            send={send} startVoice={startVoice} stopVoice={stopVoice} />
        </div>
        <CartBar cart={cart} setCart={setCart} checkouts={checkouts} setCheckouts={setCheckouts} run={act} />
        <Shelf products={products} room={room} act={act} cart={cart} />
        <ModelLog trace={trace} />
        <footer className="st-foot">Space Theory · Gemini 4 (Carbon, Neon, Hydrogen, Decision 1) · Gemini Live · Nano Banana · Shopify</footer>
      </main>
    </>
  );
}

createRoot(document.getElementById("app")).render(<App />);
