import { defineConfig } from 'vite';

// Use a subpath base when building for GitHub Pages under /vinci/; keep dev at root
export default defineConfig(({ command }) => ({
  root: 'viewer',
  base: command === 'build' ? '/vinci/' : '/',
  server: {
    port: 5173,
    open: '/index.html'
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  }
}));
