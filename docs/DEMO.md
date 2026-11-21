# Space Theory: 3-minute live demo + judge Q&A

## Before you go on (2 min)
- `npm run dev` (laptop) or `npm run phone` (phone camera). Open in **Chrome**, allow camera + mic.
- Point the camera at a real empty wall or corner at the venue. Don't rehearse the exact words; the judges want unscripted input.
- Have the **model log** visible (scroll to "Which Gemini model did what"). It proves which model did what.
- Have `eval/REPORT.md` open in a second tab.

## The 3 minutes
| Time | Say / do | What the judges see |
| --- | --- | --- |
| 0:00 | "Furniture is the most-returned thing people buy online, because nobody knows if it fits. Space Theory is a live call that fixes that." Tap **Start call**. | Camera on, the designer greets you by voice |
| 0:10 | Point the phone at the hackathon room: *"Redesign this space as a cozy Japandi lounge."* | Nano Banana restyles the real room (≈30 s; keep talking over it) + Neon lists the pieces as tappable chips |
| 0:15 | Point at the wall: *"I need a sofa for this wall, under $1,800."* | Decision 1 gate (≈0.2 s) → Neon reads the room → open space estimated in cm |
| 0:40 | (The designer searches) | Real Shopify products, each with **Fits · X cm to spare** or **Too wide**. Hydrogen workers + Decision 1 ranking in the log |
| 1:00 | *"Show me the first one in 3D."* | Carbon's measured 3D model **over the live camera at true size**; the checklist shows the rule checks, then the visual self-check score |
| 1:30 | Tap **VS** on two cards. | Two products side by side at true scale, next to a 170 cm person |
| 1:40 | Drag to rotate it. *"Put it in my room."* | Nano Banana draws it into the actual camera frame |
| 2:10 | *"I'll take it. Check out."* | Cart → Rucha's Shopify checkout → shopper confirms and pays |
| 2:40 | Flip to `eval/REPORT.md` | Pipeline vs baseline on 30 unseen products, and the failure we fixed |

## Q&A answers (have these ready)
**What's the baseline, and how much better are you?**
One Carbon call, "build this product in 3D", on the same 30 unseen Shopify products. With the full listing, the baseline gets all three axes within 10% for 83% of products, and Space Theory gets **100%** (0.0% mean error vs 7.6%). Structure checks pass 100% vs 96.7%.

**How did you build a test set that isn't the happy path?**
A seeded random sample from public Shopify stores we didn't build against. Ground truth is the W × D × H printed in each listing. Nothing was written by us. It's messy on purpose: pendant lights whose height includes the chain, folded sofa beds, L-shaped benches, outdoor sets. Condition B scrubs every dimension from the text (photo only), like an Instagram post.

**Where does it still fail, and what did you change?**
On photo-only inputs our first pipeline was *worse* than the baseline (11.9% vs 10.5% error), because Neon's text-based size estimate overrode Carbon's own sense of scale and then got locked in. We checked offline: Carbon's photo estimate beat Neon's and beat averaging them. So now only axes the listing actually states are locked, and Carbon sizes the rest. *After the fix it beats the baseline on photo-only inputs: 8.3% vs 9.1% mean error.* Remaining failures: lights (the chain length isn't visible), and listings whose "dimensions" are really box or folded sizes.

**Why these models?**
- **Decision 1**: closed-set judgments in about 200 ms with calibrated confidence. Frame gate, ranking 16 products in one call, 3D likeness score.
- **Carbon**: the hardest spatial reasoning, turning photos into a measured part model.
- **Neon**: room reading and analysis while the user waits.
- **Hydrogen**: cheap parallel workers (one per product) and the chat agent.
- **Live 3.8**: the voice + camera call.
- **Nano Banana**: in-room preview.

**What does the raw video give you that text wouldn't?**
Scale. The open wall width comes from reference objects in the frame (doors, outlets, chairs), and the placement preview uses your actual room, light and perspective.

**Is money safe?**
The designer never pays. Checkout opens Shopify's own page; the shopper confirms.
