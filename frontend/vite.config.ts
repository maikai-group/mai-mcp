/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev proxy → the mai-brain-web server (web-server.ts DEFAULT_PORT). The built
// app is served by that same server from frontend/dist, so /api is same-origin
// in production; the proxy only matters for `vite dev`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://127.0.0.1:6601' } },
  build: { outDir: 'dist' },
  test: {
    environment: 'jsdom',
    globals: true,
    // Unit tests live in src/; e2e/ is Playwright's (its own runner), keep it out.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
