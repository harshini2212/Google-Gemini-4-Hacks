# Space Theory eval: true-size 3D from real Shopify products

**Question:** does Space Theory build a product in 3D at its *real* size, on products we never looked at?

- **Test set:** 30 products sampled at random (seed 7) from public Shopify stores (Tribesigns, Walker Edison, Albany Park). Ground truth is the overall W × D × H printed in each listing; nothing was written or picked by us. It is messy: pendant lights whose height includes the chain, folded sofa beds, L-shaped benches, outdoor sets.
- **Baseline:** one Gemini 4 Carbon call: "build this product in 3D".
- **Space Theory:** size resolution → Carbon draft → rule checks in code → up to 2 repairs → snap stated axes to the listing.
- **Error:** the 3D model's bounding box vs the listed size, averaged over the three axes.

## Results

| Condition | System | Mean size error | Median | All 3 axes within 10% | Passes structure checks |
|---|---|---|---|---|---|
| **A · full listing** (photos + text) | baseline | 7.6% | 0.4% | 83.3% | 96.7% |
| | **Space Theory** | **0.0%** | **0.0%** | **100%** | **100%** |
| **B · photo only** (all dimensions scrubbed), v1 | baseline | 10.5% | 2.8% | 60.0% | 100% |
| | Space Theory v1 | 11.9% ❌ | 6.3% | 40.0% | 100% |
| **B · photo only**, v2 (after the fix, 29 paired products) | baseline | 9.1% | 2.5% | — | — |
| | **Space Theory v2** | **8.3%** | **2.4%** | — | — |

First-draft pass rate on the rule checks: 96.7%. Average repairs per product: 0.03.

## What failed, and what we changed

**v1 lost to the baseline on photo-only inputs.** When a listing gave no size, a Gemini 4 Neon step estimated it from the text and photo, and the pipeline then *locked* the model to that estimate. Neon's guesses were worse than Carbon's own sense of scale. We checked offline on the saved results:

| Size source (photo only, n = 30) | Mean error | Within 10% |
|---|---|---|
| Neon text estimate (v1) | 11.9% | 40% |
| Average of Neon + Carbon | 11.1% | 60% |
| **Carbon's own estimate from the photos** | **10.5%** | **60%** |

**Fix (v2):** only axes the listing actually states are locked; Carbon sizes everything else from the photos. The rule checks, repair loop and visual self-check still run. v2 now beats the baseline on photo-only inputs (8.3% vs 9.1%) and stays perfect when the listing states the size.

## Where it still fails
- **Pendant lights:** the listed height includes the hanging chain, which isn't visible in the photo (25–40% off).
- **Listings whose "dimensions" are box or folded sizes** (a sofa bed listed at 152 × 38 × 38 cm).
- **Ambiguous axis labels** (a nightstand listed as 15.7" W × 35.4" D).

Reproduce with `npm run eval -- --n 30` (both conditions) or `--conditions B`.
