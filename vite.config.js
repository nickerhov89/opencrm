import { defineConfig } from 'vite';
export default defineConfig({
  base: process.env.OPENCRM_BASE_PATH || '/',
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': process.env.OPENCRM_DEV_API_TARGET || 'http://127.0.0.1:3001' } }
});
