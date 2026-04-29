import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { readFileSync } from 'fs';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
const wasmCoreVersion = packageJson.dependencies['@ladybugdb/wasm-core'];

export default defineConfig({
  base: './',
  root: '.',
  publicDir: 'public',
  define: {
    __WASM_CORE_VERSION__: JSON.stringify(wasmCoreVersion),
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  server: {
    port: 3000,
    host: true,
    fs: {
      allow: ['..'],
    },
  },
  optimizeDeps: {
    exclude: ['@ladybugdb/wasm-core']
  }
});
