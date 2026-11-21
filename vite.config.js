import { defineConfig } from 'vite';
import { darkThemePlugin } from './scripts/dark-theme.mjs';
export default defineConfig({
  base: process.env.OPENCRM_BASE_PATH || '/',
  css: { postcss: { plugins: [darkThemePlugin()] } },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': process.env.OPENCRM_DEV_API_TARGET || 'http://127.0.0.1:3001' } }
});
