import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// `npm run dev` serves the UI with hot reload and proxies API calls to `wrangler dev` (npm run dev:api).
export default defineConfig({
  plugins: [tailwindcss()],
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:8787', '/.well-known': 'http://localhost:8787' } },
});
