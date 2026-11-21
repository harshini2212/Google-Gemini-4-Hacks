// OWNER: Rucha (see docs/TEAM-PLAN.md). The cart bar + checkout sheet.
import React from "react";
import { ExternalLink, ShoppingBag, X } from "lucide-react";
import "./commerce.css";

const money = n => `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

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
          <div className="checkout-head"><h3>Pay on each store's own checkout</h3><button type="button" onClick={() => setCheckouts(null)} aria-label="Close"><X size={16} /></button></div>
          {checkouts.map(c => (
            <a key={c.store} className="checkout-row" href={c.url} target="_blank" rel="noreferrer">
              <span><b>{c.storeName}</b> · {c.lines.map(l => `${l.quantity}× ${l.title}`).join(", ")}</span>
              <span>{money(c.total)} <ExternalLink size={14} /></span>
            </a>
          ))}
          <p>the designer fills the cart. You review and pay on the store's own Shopify checkout.</p>
        </div>
      )}
    </section>
  );
}
