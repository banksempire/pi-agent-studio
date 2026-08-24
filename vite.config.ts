import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

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
        target: process.env.PI_API_PROXY ?? 'http://127.0.0.1:7493',
        changeOrigin: true,
      },
    },
  },
});
