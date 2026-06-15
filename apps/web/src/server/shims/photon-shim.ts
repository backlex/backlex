// Workers-only shim for `@cf-wasm/photon`. The WASM image adapter
// (`image.wasm.ts`) is gated off on Workers (Cloudflare Image Resizing handles
// transforms there) and never imports Photon, but its dynamic
// `import("@cf-wasm/photon")` would otherwise pull the WASM blob into the Worker
// bundle's cold-start graph. This empty stub keeps it out; `wasmImage()` sees no
// `PhotonImage` export and returns null.
export {};
