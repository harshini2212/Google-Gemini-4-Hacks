// Space Theory's tools, shared by the Gemini Live voice session (browser) and the typed chat (server).
const T = { O: "OBJECT", S: "STRING", N: "NUMBER", I: "INTEGER" };

function tool(name, description, properties = {}, required = Object.keys(properties)) {
  return { name, description, parameters: { type: T.O, properties, required } };
}

export const homeTools = [
  tool("look_at_room",
    "Look at the live camera frame right now: room type, style, palette, what is already there, and open floor spaces with estimated sizes. Call this before recommending furniture, and again when the shopper points the camera somewhere new.",
    { goal: { type: T.S, description: "What the shopper wants for this space." } }),
  tool("find_products",
    "Search real Shopify stores for products, ranked for this room and space. Returns up to 6 products with price, store, size and whether they fit.",
    {
      query: { type: T.S, description: "Short product search, e.g. 'sofa', 'floor lamp', 'accent chair', 'storage ottoman'." },
      max_price: { type: T.N, description: "Optional budget in USD per item." },
      space_width_cm: { type: T.N, description: "Optional width of the open space it must fit in, in cm." },
    }, ["query"]),
  tool("show_in_3d",
    "Build a measured 3D model of a product from its photos and listing, and show it over the live camera so the shopper can turn it around and see its true size.",
    { product_id: { type: T.S, description: "A product id returned by find_products." } }),
  tool("place_in_room",
    "Draw the product into a photo of the shopper's actual room, from the current camera frame. Takes about 10 seconds. Call it a preview.",
    {
      product_id: { type: T.S, description: "A product id returned by find_products." },
      where: { type: T.S, description: "Where it goes, e.g. 'against the left wall under the window'." },
    }, ["product_id"]),
  tool("add_to_cart",
    "Add a product to the shopper's cart. Only when the shopper says they want it.",
    {
      product_id: { type: T.S, description: "A product id returned by find_products." },
      quantity: { type: T.I, description: "How many. Default 1." },
    }, ["product_id"]),
  tool("checkout",
    "Open the real Shopify checkout for everything in the cart. The shopper reviews and pays on the store's own page. Only after they confirm they are ready to buy."),
];

export const homeInstructions = `You are Theo, a warm, quick interior guide on a live video call. The shopper points their phone camera at their own room and talks to you.
Speak in one to three short sentences, like a person on a video call. Never read out ids, URLs or long numbers.
Loop: look at the room (look_at_room) -> understand what they want -> find_products -> show the best one in 3D (show_in_3d) -> offer to place it in their room (place_in_room) -> add_to_cart when they want it -> checkout when they say they're ready.
If look_at_room says the camera is off, never block on it: still search and show products, and say you'll check the fit once they point the camera at the space.
When the shopper asks for something specific, act right away with the tools instead of asking questions first.
Always say whether an item fits using the measured numbers the tools return, never by guessing. Say that sizes from the camera are estimates and offer to use a tape-measure number if they have one.
Products and prices come from real Shopify stores; name the store. A placed-in-room picture is a preview, not a promise of exact appearance.
You never pay for anything: checkout opens the store's own checkout page and the shopper pays there.
If a tool returns an error, say what went wrong in plain words and offer the next best step.`;
