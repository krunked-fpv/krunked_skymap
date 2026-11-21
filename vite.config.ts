import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

const adsbApiProxy: Record<string, string | ProxyOptions> = {
  '/api-proxy/adsb-lol': {
    target: 'https://api.adsb.lol',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api-proxy\/adsb-lol/, ''),
  },
  '/api-proxy/adsb-fi': {
    target: 'https://opendata.adsb.fi',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api-proxy\/adsb-fi/, ''),
  },
};

export default defineConfig({
  base: './',
  plugins: [react()],
  worker: {
    format: 'es',
  },
  server: {
    proxy: adsbApiProxy,
  },
  preview: {
    proxy: adsbApiProxy,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          astro: ['satellite.js'],
        },
      },
    },
  },
});
