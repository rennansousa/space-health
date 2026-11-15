import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// One codebase: web (PWA, works offline), Android and iOS (Capacitor wraps dist/).
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Space Health',
        short_name: 'Space Health',
        description: 'Astronaut health companion — works offline on board.',
        theme_color: '#0D1B2E',
        background_color: '#F3F6FA',
        display: 'standalone',
        orientation: 'any',
        start_url: './',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2,glb}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
  // /api goes to the Python server, so phones on the LAN and IPv6 localhost work in dev too.
  server: {
    port: 5174,
    host: true,
    proxy: { '/api': { target: process.env.SPACE_HEALTH_API ?? 'http://127.0.0.1:8000', changeOrigin: true } },
  },
});
