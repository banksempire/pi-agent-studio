import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

function apiProxyTarget() {
  try {
    const stateDir = process.env.PI_STUDIO_STATE_DIR ?? path.resolve(process.cwd(), '..', '.studio', 'state');
    const rec = JSON.parse(fs.readFileSync(path.join(stateDir, 'pids', 'web.json'), 'utf8'));
    if (rec?.pid === process.pid && rec?.backendPort) return `http://127.0.0.1:${Number(rec.backendPort)}`;
  } catch {}
  return process.env.PI_API_PROXY ?? 'http://127.0.0.1:7494';
}

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@sf': fileURLToPath(new URL('../StudioFramework/src', import.meta.url)),
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue'],
          markdown: ['marked', 'dompurify'],
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 7492,
    allowedHosts: ['mbp', 'localhost', '.local'],
    watch: {
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 20,
      },
    },
    proxy: {
      '/api': {
        target: apiProxyTarget(),
        changeOrigin: true,
      },
    },
  },
});
