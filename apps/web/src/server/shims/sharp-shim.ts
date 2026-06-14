// Worker-only shim for `sharp`. sharp is a native addon (`@img/sharp-*`) that
// can't load on the Cloudflare Workers V8 isolate. The sharp image adapter is
// never selected on Workers (gated out in `image.sharp.ts::sharpImage`, which
// returns null when `WebSocketPair` exists), and Workers resize at the edge via
// CF Image Resizing instead. This stub only exists so the bundler's dynamic
// `import("sharp")` resolves to something small; calling it throws.
const unavailable = (): never => {
  throw new Error(
    "sharp is not available on Cloudflare Workers — images resize at the edge via Cloudflare Image Resizing (set R2_PUBLIC_BASE).",
  );
};

export default unavailable;
