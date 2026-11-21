# Space Theory

**Shop your own room on a live video call.** Point your phone camera at a room and talk to the designer. The designer looks at the space, finds real products in Shopify stores, and rebuilds each one as a **measured 3D model** at its true size. You can turn the model around over your live camera, or have the designer draw it into a photo of your room. When you decide, the designer fills a real Shopify cart, and you confirm and pay.

Built at the Gemini 4 NYC Hackathon, 21 November 2026 · Problem Statement Two (Element 119) + Shopify track.

## What it does live
- **Redesign your real room**: "make this a cozy Japandi lounge" gives a photoreal redesign of *your* camera frame (same walls, windows, doors), plus a shoppable list of the new pieces.
- **Find what fits**: real products from six Shopify stores, each marked **Fits · X cm to spare** or **Too wide**.
- **True-size 3D**: every product rebuilt as a measured 3D model over your live camera, next to a 170 cm person for scale.
- **Compare two pieces side by side** at true scale.
- **Place it in your room**: a preview drawn into your actual frame.
- **Buy it**: a real Shopify checkout that you confirm.
- **See the models work**: a live rail shows which Gemini model is doing which job, as it happens.

## The loop

1. **See**: Gemini 3.8 Live watches the camera at 1 fps and listens. `look_at_room` runs a **Decision 1** gate ("is this a space?") in about 200 ms, then **Gemini 4 Neon** reads the full frame. It returns the room type, style, palette, existing items, and open floor spaces sized from visible reference objects (doors, outlets, chairs).
2. **Find**: `find_products` searches six real Shopify storefronts at once. Parallel **Gemini 4 Hydrogen** workers read each listing's specs, and **Decision 1** ranks every candidate as a rubric question in one call. Fit (`fits / too wide / cm to spare`) is computed in code from the numbers, never by a model.
3. **Build in 3D**: `show_in_3d` has **Gemini 4 Carbon** turn the product's photos and listing into a part-based 3D model (legs, frame, cushions, arms, shades…) in centimetres, rendered with three.js over the live camera. Every model runs through a plan it is checked against:
   - **Dimensions**: overall W × D × H from the listing, or resolved by Neon when the listing is silent.
   - **Rule checks (code)**: overall size within 8% on every axis, standing on the floor, no floating parts, valid geometry.
   - **Repair**: failures go back to Carbon as concrete issues, for up to 2 rounds.
   - **Snap**: a deterministic final scale to the measured size.
   - **Visual check**: the browser renders the model, and **Decision 1** scores its likeness to the real product photo. Below 7/10, Neon lists the differences and Carbon repairs them.
   - The top-ranked product is pre-built in the background, so "show it in 3D" is usually instant.
4. **Place**: `place_in_room` gives **Nano Banana 2.1** your actual camera frame, the product photo and its true size, and returns a preview in *your* room.
5. **Buy**: `add_to_cart` → `checkout` builds a real Shopify checkout. The shopper reviews and pays; the designer never pays on its own.

## Gemini models, one job each

| Model | Id | Job |
| --- | --- | --- |
| Gemini 3.8 Live | `gemini-3.8-live` | Real-time voice + camera call; decides when to call each tool |
| **Gemini 4 Carbon** | `gemini-4-carbon` | Deepest reasoning: drafts and repairs the measured 3D part model |
| **Gemini 4 Neon** | `gemini-4-neon` | Fast analysis while you wait: reads the room, resolves dimensions, lists render-vs-photo differences |
| **Gemini 4 Hydrogen** | `gemini-4-hydrogen` | Typed chat agent + parallel spec-reading workers for every search result |
| Gemini Decision 1 | `gemini-decision-1` | Decisions API: frame gate (yes/no), product ranking (rubric), 3D likeness (rubric) |
| Nano Banana 2.1 | `gemini-nano-banana-2.1` | Places the chosen product into the shopper's camera frame |

Gemini 4 calls use thinking levels only (no temperature). 3D builds run Carbon at `LOW` for live speed (about 15 s); set `BUILD_THINKING=MEDIUM` for maximum quality. Every call retries 503s with backoff. The app shows a live log of each model call (role, job, model, latency).

## Proof it works: the eval

| | Baseline (one Carbon call) | Space Theory |
|---|---|---|
| Full listing: mean size error | 7.6% | **0.0%** |
| Full listing: all 3 axes within 10% | 83% | **100%** |
| Photo only: mean size error (after the fix) | 9.1% | **8.3%** |

Our first version *lost* on photo-only inputs (11.9% vs 10.5%). We found out why, fixed it, and re-measured. Full write-up: [`eval/REPORT.md`](eval/REPORT.md).

### How the eval works

`eval/run.mjs` measures whether products come out at their **true size**, on products the team never looked at.

- **Test set**: a seeded random sample of real products from public Shopify stores whose listing prints overall W × D × H. Those numbers are the ground truth; nothing is hand-picked or written by us. The set is messy: pendant lights whose height includes the chain, folded sofa beds, L-shaped benches, sectionals, outdoor sets.
- **Conditions**: **A** gives the full listing (photos, title and text). **B** gives photos and title only, with every dimension scrubbed from the text, as with an Instagram post or showroom photo.
- **Baseline**: one Carbon call ("build this product in 3D"), with no dimension step, checks or repair.
- **Metrics**: mean per-axis size error, the share with all three axes within 10%, structural validity, first-draft pass rate, repairs per product, and time.

```bash
npm run eval -- --n 30                 # writes eval/REPORT.md + eval/results/*.json
node eval/run.mjs --collect-only       # list the test set only (no API calls)
npm test                               # offline checks of the rule engine and parsers
```

Results and the worst failures: [`eval/REPORT.md`](eval/REPORT.md).

## Run it

Needs Node 22+ and a Gemini API key.

```bash
npm install
cp .env.example .env    # add GEMINI_API_KEY
npm run dev             # http://localhost:5180
npm run phone           # also serves https://<wifi-ip>:5443 so a phone camera can join
```

## Team

| Area | Owner |
| --- | --- |
| Live call, 3D generator, room reading, ranking, placement, eval, app | Harshini |
| Shopify catalog, cart, checkout, transactions | Rucha |

Plan and API contracts: [`docs/TEAM-PLAN.md`](docs/TEAM-PLAN.md).

## Known limits

- Room sizes from one camera frame are estimates. The designer says so and asks for a tape-measure number.
- The 3D models are part-based approximations built for size and silhouette, not photoreal scans.
- The placed-in-room image is a generated preview.
- Public storefronts can rate-limit; search falls back to a cached catalog.
