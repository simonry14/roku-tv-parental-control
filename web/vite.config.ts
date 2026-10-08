import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Dashboard build. `npm run build:web` → web/dist (served by the service on http.port).
 * `npm run dev:web` → Vite dev server on :5173 with /api proxied to a running service.
 */
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8090', changeOrigin: false } },
    // The dashboard shares src/enforce/message-catalog.ts and the channel's artwork.
    fs: { allow: [path.join(here, '..')] },
  },
});
