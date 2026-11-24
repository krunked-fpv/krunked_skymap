import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

const configureAdsbProxy: NonNullable<ProxyOptions['configure']> = (proxy) => {
  proxy.on('proxyReq', (proxyReq) => {
    proxyReq.removeHeader('origin');
    proxyReq.removeHeader('referer');
    proxyReq.setHeader(
      'User-Agent',
      'KrunkedSkyMap/2.0 (+https://github.com/krunked-fpv/krunked_skymap)'
    );
  });
};

function createAdsbProxyEntry(prefix: string, target: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    rewrite: (path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path),
    configure: configureAdsbProxy,
  };
}

const adsbApiProxy: Record<string, string | ProxyOptions> = {
  '/api-proxy/adsb-lol': createAdsbProxyEntry('/api-proxy/adsb-lol', 'https://api.adsb.lol'),
  '/api-proxy/adsb-fi': createAdsbProxyEntry('/api-proxy/adsb-fi', 'https://opendata.adsb.fi'),
  '/api-proxy/airplanes-live': createAdsbProxyEntry(
    '/api-proxy/airplanes-live',
    'https://api.airplanes.live'
  ),
  '/api-proxy/windborne': createAdsbProxyEntry('/api-proxy/windborne', 'https://a.windbornesystems.com'),
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
        },
      },
    },
  },
});
