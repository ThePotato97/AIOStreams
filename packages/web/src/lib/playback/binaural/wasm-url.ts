/** Where the renderer's WebAssembly is (built by scripts/build-atmos-wasm.sh). */
export const wasmUrl: string | null = new URL(
  './atmos_render.wasm',
  import.meta.url
).href;
