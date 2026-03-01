import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';

export default defineConfig({
  base: './',
  root: '.',
  publicDir: 'public',
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
