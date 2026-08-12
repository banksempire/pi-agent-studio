import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // Consume StudioFramework source directly (sibling repo)
      '@sf': fileURLToPath(new URL('../StudioFramework/src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 7492,
    allowedHosts: ['mbp', 'localhost', '.local'],
    watch: {
      // Editors write files non-atomically; without this the watcher can
      // read a half-written file and vite caches the failed (empty) CSS
      // transform until the next change.
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 20,
      },
    },
    proxy: {
      // pi-agent-studio backend (src/pi-studio/server/index.mjs) — real pi agent sessions
      '/api': {
        target: 'http://127.0.0.1:7493',
        changeOrigin: true,
      },
    },
  },
});
