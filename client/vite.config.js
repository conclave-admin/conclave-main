import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';

export default defineConfig({
  plugins: [react(), svgr()],
  server: {
    port: 5173,
    // Playwright writes screenshots and traces while Vite is running. Watching
    // the test tree wastes handles and can exhaust inotify on Linux.
    watch: { ignored: ['**/e2e/**', '**/dist/**'] },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
