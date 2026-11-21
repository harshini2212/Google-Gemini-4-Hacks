// OWNER: Rucha (see docs/TEAM-PLAN.md). The cart bar + checkout sheet.
// The shopper always confirms: Theo only builds the checkout, the shopper taps "Confirm & pay".
import React, { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, ShoppingBag, X } from "lucide-react";
import { orderStatus } from "./client.mjs";
import "./commerce.css";

const money = n => `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

// One review card per store. Dev-store checkouts (they carry a `ref`) are polled until the real order appears.
function StoreCheckout({ c }) {
  const [state, setState] = useState({ phase: "review" });

  useEffect(() => {
    if (state.phase !== "paying" || !c.ref) return undefined;
    let stop = false, tries = 0, timer;
    const tick = async () => {
      try {
        const s = await orderStatus(c);
        if (stop) return;
        if (s.status === "paid") return setState({ phase: "placed", orderName: s.orderName });
      } catch { /* keep polling; the order may simply not exist yet */ }
      if (stop) return;
      if (++tries >= 100) return setState({ phase: "timeout" });
      timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 2500);
    return () => { stop = true; clearTimeout(timer); };
  }, [state.phase, c]);

  const confirm = () => {
    window.open(c.url, "_blank", "noopener,noreferrer");
    setState({ phase: "paying" });
  };

  return (
    <div className="checkout-card">
      <div className="checkout-store"><b>{c.storeName}</b>{c.test && <em className="test-badge">Test order · no real charge</em>}</div>
      <ul className="checkout-lines">
        {c.lines.map(l => (
          <li key={`${l.variantId}`}><span>{l.quantity}× {l.title}{l.variant && l.variant !== "Default Title" ? ` · ${l.variant}` : ""}</span><span>{money(l.price * l.quantity)}</span></li>
        ))}
      </ul>
      <div className="checkout-total"><span>Total</span><b>{money(c.total)}</b></div>

      {state.phase === "review" && (
        <button type="button" className="btn btn-accent checkout-confirm" onClick={confirm}>
          Confirm &amp; pay <ExternalLink size={14} />
        </button>
      )}
      {state.phase === "paying" && (
        <p className="checkout-status">
          {c.ref ? <><span className="spin" /> Waiting for your payment…{" "}</> : "Finish paying in the store tab. "}
          <a href={c.url} target="_blank" rel="noreferrer">Reopen checkout</a>
        </p>
      )}
      {state.phase === "placed" && (
        <p className="checkout-status checkout-placed"><CheckCircle2 size={18} /> Order {state.orderName} placed ✓</p>
      )}
      {state.phase === "timeout" && (
        <p className="checkout-status">Still no order. <a href={c.url} target="_blank" rel="noreferrer">Reopen checkout</a></p>
      )}
    </div>
  );
}

// Props contract (do not rename without telling Harshini):
//   cart:        CartItem[]  { productId, variantId, title, price, quantity }
//   setCart:     (CartItem[]) => void
//   checkouts:   Checkout[] | null   (what POST /api/checkout returned)
//   setCheckouts:(Checkout[] | null) => void
//   run:         (toolName, args) => Promise  — call run("checkout", {}) to start checkout
export function CartBar({ cart, setCart, checkouts, run, setCheckouts }) {
  if (!cart.length && !checkouts) return null;
  const total = cart.reduce((sum, c) => sum + c.price * c.quantity, 0);
  return (
    <section className="cart-bar">
      <ShoppingBag size={18} />
      <div className="cart-items">
        {cart.map(c => (
          <span key={c.productId} className="cart-chip">{c.quantity > 1 ? `${c.quantity}× ` : ""}{c.title}
            <button type="button" aria-label={`Remove ${c.title}`} onClick={() => setCart(cart.filter(x => x.productId !== c.productId))}><X size={12} /></button>
          </span>
        ))}
      </div>
      <b>{money(total)}</b>
      <button type="button" className="btn btn-accent" disabled={!cart.length} onClick={() => run("checkout", {})}>Checkout</button>
      {checkouts && (
        <div className="checkout-sheet" role="dialog" aria-label="Checkout">
          <div className="checkout-head"><h3>Review your order</h3><button type="button" onClick={() => setCheckouts(null)} aria-label="Close"><X size={16} /></button></div>
          {checkouts.map(c => <StoreCheckout key={c.ref ?? c.store} c={c} />)}
          <p>Theo never pays for you. You confirm, then pay on the store's own Shopify checkout.</p>
        </div>
      )}
    </section>
  );
}
