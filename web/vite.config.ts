/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API and the ad server run on their own ports; in production nginx serves
// this build and proxies /api and /ads, so the browser only ever talks to one origin.
const strip = (prefix: string) => (path: string) => path.replace(new RegExp(`^${prefix}`), '');

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:3000', rewrite: strip('/api') },
      '/ads': { target: process.env.ADS_URL ?? 'http://localhost:8080', rewrite: strip('/ads') },
    },
  },
  // No source maps in the production build: nginx would serve them, publishing the original source.
  build: { sourcemap: false, target: 'es2022' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
