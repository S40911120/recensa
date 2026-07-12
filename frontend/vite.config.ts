import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Vendor chunking: keep each chunk under 500KB (highlight.js is the biggest contributor)
        manualChunks: {
          react: ['react', 'react-dom'],
          highlight: ['highlight.js/lib/common'],
          markdown: ['marked', 'marked-highlight', 'dompurify'],
        },
      },
    },
  },
  server: {
    port: 5178,
    proxy: {
      '/api': 'http://127.0.0.1:7788',
      '/ws': { target: 'ws://127.0.0.1:7788', ws: true },
    },
  },
});
