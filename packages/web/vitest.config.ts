import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __LIBAV_DECODERS__: '[]' },
  resolve: {
    alias: {
      // No workers here: the binaural renderer's own tests load the WebAssembly directly.
      'atmos-render-wasm-url': fileURLToPath(
        new URL(
          './src/lib/playback/binaural/wasm-url-missing.ts',
          import.meta.url
        )
      ),
      'libav-eac3': fileURLToPath(
        new URL(
          './src/lib/playback/binaural/libav-eac3-missing.ts',
          import.meta.url
        )
      ),
    },
  },
});
