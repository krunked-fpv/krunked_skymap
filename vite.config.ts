import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  worker: {
    format: 'es',
  },
  server: {
    proxy: {
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
    },
  },
  preview: {
    proxy: {
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
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
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
