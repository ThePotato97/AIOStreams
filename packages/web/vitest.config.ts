import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // As tsconfig and rsbuild resolve it.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
